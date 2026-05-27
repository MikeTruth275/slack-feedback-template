// Feedback storage backed by Aurora PostgreSQL (production) or in-memory (local dev).
// The Lambda connects with IAM database authentication and TLS.

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME || "feedback";
const DB_PORT = Number(process.env.DB_PORT || "5432");
const DB_USER = process.env.DB_USER;
const DB_REGION = process.env.AWS_REGION || "us-east-1";
const DB_CA_BUNDLE_PATH = path.join(__dirname, "rds-global-bundle.pem");
const DB_CA_BUNDLE = fs.existsSync(DB_CA_BUNDLE_PATH)
  ? fs.readFileSync(DB_CA_BUNDLE_PATH, "utf8")
  : null;
const DB_CONNECTION_TIMEOUT_MS = 5000;
const DB_QUERY_TIMEOUT_MS = 5000;
const DB_STATEMENT_TIMEOUT_MS = 5000;
const RETRYABLE_CONNECTION_ERROR_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08006",
  "ECONNRESET",
  "ETIMEDOUT",
]);

// Use pg.Pool with max:1 instead of a single pg.Client. Behavior is the same
// under normal load (one container = one connection) but the pool transparently
// recreates dead connections, queues concurrent queries safely, and rotates
// the IAM auth token on each new connection -- which matters because IAM
// tokens expire after 15 minutes.
let pool = null;

function isRetryableConnectionError(error) {
  if (!error) return false;
  return (
    RETRYABLE_CONNECTION_ERROR_CODES.has(error.code) ||
    /connection terminated unexpectedly/i.test(error.message || "") ||
    /terminating connection/i.test(error.message || "") ||
    /Connection ended unexpectedly/i.test(error.message || "")
  );
}

async function getPool() {
  if (pool) return pool;
  if (!DB_HOST || !DB_USER) return null;

  const { defaultProvider } = require("@aws-sdk/credential-provider-node");
  const { Signer } = require("@aws-sdk/rds-signer");
  const { Pool } = require("pg");

  const signer = new Signer({
    credentials: defaultProvider(),
    hostname: DB_HOST,
    port: DB_PORT,
    region: DB_REGION,
    username: DB_USER,
  });

  pool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    // `password` can be a function -- the pool calls it on each new connection,
    // which gives us a fresh IAM auth token automatically.
    password: () => signer.getAuthToken(),
    application_name: process.env.DB_APPLICATION_NAME || "slack-feedback-template",
    max: 1,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 0,
    query_timeout: DB_QUERY_TIMEOUT_MS,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    ssl: DB_CA_BUNDLE
      ? { ca: DB_CA_BUNDLE, rejectUnauthorized: true }
      : { rejectUnauthorized: true },
  });

  pool.on("error", (error) => {
    // Pool emits 'error' for idle-connection failures. The pool will recreate
    // the connection on the next query; we just need to not crash.
    console.error("Idle PostgreSQL pool error:", error.message);
  });

  return pool;
}

async function queryDb(text, params) {
  const p = await getPool();
  if (!p) return null;

  try {
    return await p.query(text, params);
  } catch (error) {
    if (!isRetryableConnectionError(error)) throw error;
    // pg.Pool already evicts the bad client; just re-issue the query, which
    // will check out (or create) a fresh connection.
    return p.query(text, params);
  }
}

function toPersistenceValues(record) {
  return [
    record.id,
    new Date(record.createdAt),
    record.assignedPm?.userId || null,
    record.status,
    record.submission.urgency,
    record.threadTs,
    JSON.stringify(record),
  ];
}

async function putRecord(record) {
  const client = await getPool();
  if (!client) {
    localStore.set(record.id, record);
    return;
  }

  await queryDb(
    `
      INSERT INTO feedback (
        id,
        created_at,
        assigned_pm_user_id,
        status,
        urgency,
        thread_ts,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        created_at = EXCLUDED.created_at,
        assigned_pm_user_id = EXCLUDED.assigned_pm_user_id,
        status = EXCLUDED.status,
        urgency = EXCLUDED.urgency,
        thread_ts = EXCLUDED.thread_ts,
        payload = EXCLUDED.payload
    `,
    toPersistenceValues(record)
  );
}

async function getRecord(id) {
  const client = await getPool();
  if (!client) return localStore.get(id) || null;

  const result = await queryDb(
    "SELECT payload FROM feedback WHERE id = $1 LIMIT 1",
    [id]
  );
  return result.rows[0]?.payload || null;
}

async function findByThreadTs(threadTs) {
  const client = await getPool();
  if (!client) {
    return Array.from(localStore.values()).find((record) => record.threadTs === threadTs) || null;
  }

  const result = await queryDb(
    "SELECT payload FROM feedback WHERE thread_ts = $1 LIMIT 1",
    [threadTs]
  );
  return result.rows[0]?.payload || null;
}

async function getByPm(pmUserId, { status, limit = 20 } = {}) {
  const client = await getPool();
  if (!client) {
    const records = Array.from(localStore.values()).filter(
      (record) => record.assignedPm?.userId === pmUserId && (!status || record.status === status)
    );
    return sortRecords(records).slice(0, limit);
  }

  const params = [pmUserId];
  let statusClause = "";
  if (status) {
    params.push(status);
    statusClause = " AND status = $2";
  }
  params.push(limit);

  const result = await queryDb(
    `
      SELECT payload
      FROM feedback
      WHERE assigned_pm_user_id = $1${statusClause}
      ORDER BY
        CASE urgency
          WHEN 'blocking' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 99
        END,
        created_at DESC
      LIMIT $${params.length}
    `,
    params
  );

  return result.rows.map((row) => row.payload);
}

// Active "responded" statuses. Anything past pending counts as responded for
// Home tab purposes. Centralized so we can change this in one place.
const RESPONDED_STATUSES = ["acknowledged", "in_progress", "planned", "resolved", "done"];

// Single-query alternative to calling getByPm() once per status. Used by the
// Home tab so opening it costs 2 DB round trips total (pending + responded)
// instead of 6.
async function getRespondedByPm(pmUserId, { limit = 50 } = {}) {
  const client = await getPool();
  if (!client) {
    const records = Array.from(localStore.values()).filter(
      (record) =>
        record.assignedPm?.userId === pmUserId &&
        RESPONDED_STATUSES.includes(record.status)
    );
    return sortRecords(records).slice(0, limit);
  }

  const result = await queryDb(
    `
      SELECT payload
      FROM feedback
      WHERE assigned_pm_user_id = $1
        AND status = ANY($2::text[])
      ORDER BY
        CASE urgency
          WHEN 'blocking' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 99
        END,
        created_at DESC
      LIMIT $3
    `,
    [pmUserId, RESPONDED_STATUSES, limit]
  );

  return result.rows.map((row) => row.payload);
}

async function getAll({ limit = 50 } = {}) {
  const client = await getPool();
  if (!client) {
    return sortRecords(Array.from(localStore.values())).slice(0, limit);
  }

  const result = await queryDb(
    `
      SELECT payload
      FROM feedback
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows.map((row) => row.payload);
}

function sortRecords(records) {
  const urgencyOrder = { blocking: 0, high: 1, medium: 2, low: 3 };
  return [...records].sort((a, b) => {
    const urgencyDiff =
      (urgencyOrder[a.submission.urgency] || 99) -
      (urgencyOrder[b.submission.urgency] || 99);
    if (urgencyDiff !== 0) return urgencyDiff;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

const localStore = new Map();

async function createFeedback({
  channelId, productArea, reporterUserId, reporterName, customer,
  title, type, urgency, description, replay, customFields,
  assignedPmUserId, assignedPmName,
}) {
  const id = `fb_${randomUUID().slice(0, 8)}`;
  const record = {
    id,
    createdAt: new Date().toISOString(),
    channelId,
    productArea,
    reporter: { userId: reporterUserId, name: reporterName },
    assignedPm: { userId: assignedPmUserId, name: assignedPmName },
    submission: {
      customer, title, type, urgency, description, replay,
      customFields: customFields || {},
    },
    status: "pending",
    threadTs: null,
    pmRespondedAt: null,
    responseTimeHours: null,
    // Duplicate-detection state. Populated asynchronously after the channel
    // post is created. `jiraTicket` may also gain `matchedAutomatically: true`
    // and `resolvedFromDuplicateAt` if the PM resolves via the suggestion.
    duplicateSuggestions: null,
    duplicateSuggestionsMessageTs: null,
    duplicateSuggestionsDismissedAt: null,
    jiraTicket: null,
  };
  await putRecord(record);
  return record;
}

async function updateFeedback(id, updates) {
  const record = await getRecord(id);
  if (!record) return null;
  Object.assign(record, updates);
  await putRecord(record);
  return record;
}

async function getFeedback(id) {
  return getRecord(id);
}

// Hard delete. Used to clean up orphan rows -- e.g. when chat.postMessage
// fails with not_in_channel after createFeedback has already inserted, so
// the record would otherwise show up on the PM Home tab as a pending item
// with no Slack thread to click through to.
async function deleteFeedback(id) {
  const client = await getPool();
  if (!client) {
    localStore.delete(id);
    return;
  }
  await queryDb("DELETE FROM feedback WHERE id = $1", [id]);
}

// View-submission idempotency. The Slack view_submission ack window is 3s;
// when our handler exceeds it (e.g. cold start + Bedrock), Slack shows the
// user "something went wrong" and they resubmit -- creating a duplicate.
// A second-line guard at the Lambda edge handles Slack's own auto-retries
// (those carry x-slack-retry-num), but a manual resubmit is a brand-new
// view_submission that the edge guard can't see. claimViewSubmission()
// closes that hole: only the first invocation that wins the INSERT is
// allowed to do the work; any subsequent invocation (auto-retry that
// slipped through, or manual resubmit re-using the still-open modal)
// short-circuits.
//
// In-memory set is a fast path for warm-container retries to skip a DB
// round trip; the DB is the source of truth across containers. View IDs
// are unique per Slack modal lifetime, so collisions are impossible.
const claimedViewIds = new Set();
const CLAIMED_VIEW_IDS_MAX_SIZE = 1000;

async function claimViewSubmission(viewId, { feedbackId = null } = {}) {
  if (!viewId) return true;
  if (claimedViewIds.has(viewId)) return false;

  const client = await getPool();
  if (!client) {
    claimedViewIds.add(viewId);
    if (claimedViewIds.size > CLAIMED_VIEW_IDS_MAX_SIZE) {
      // Drop oldest insertion (Set preserves insertion order).
      const oldest = claimedViewIds.values().next().value;
      claimedViewIds.delete(oldest);
    }
    return true;
  }

  // ON CONFLICT DO NOTHING + RETURNING gives us an atomic claim: rowCount=1
  // means we won the race, rowCount=0 means another invocation already has
  // it. No SELECT-then-INSERT race.
  const result = await queryDb(
    `
      INSERT INTO view_submissions (view_id, feedback_id)
      VALUES ($1, $2)
      ON CONFLICT (view_id) DO NOTHING
      RETURNING view_id
    `,
    [viewId, feedbackId]
  );

  const claimed = (result?.rowCount ?? 0) === 1;
  if (claimed) {
    claimedViewIds.add(viewId);
    if (claimedViewIds.size > CLAIMED_VIEW_IDS_MAX_SIZE) {
      const oldest = claimedViewIds.values().next().value;
      claimedViewIds.delete(oldest);
    }
  }
  return claimed;
}

module.exports = {
  createFeedback,
  updateFeedback,
  getFeedback,
  deleteFeedback,
  findByThreadTs,
  getByPm,
  getRespondedByPm,
  getAll,
  claimViewSubmission,
};
