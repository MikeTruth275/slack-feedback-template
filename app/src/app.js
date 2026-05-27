// Slack Feedback Agent -- Lambda handler (HTTP mode via AwsLambdaReceiver).
// Secrets are fetched from AWS Secrets Manager on cold start.
// On local dev (no AWS_LAMBDA_FUNCTION_NAME), falls back to Socket Mode with .env.

require("dotenv").config();
const { timingSafeEqual } = require("crypto");
const { App, AwsLambdaReceiver } = require("@slack/bolt");
const { getChannelConfig, channelConfig } = require("./channel-config");
const { createFeedback, updateFeedback, getFeedback, deleteFeedback, getByPm, getRespondedByPm, claimViewSubmission } = require("./store");
const {
  buildFeedbackModal,
  buildFeedbackPost,
  applyJiraTicketToFeedbackBlocks,
  applyDuplicateHintToBlocks,
  removeDuplicateHintFromBlocks,
  buildDuplicateSuggestionsBlocks,
  buildResponseModal,
  buildHomeTab,
  buildRoutingNudgeBlocks,
  buildRerouteModal,
  buildMovedBanner,
  buildReroutedFromBanner,
  applyMovedBannerAndStripActions,
  buildJiraTicketModal,
  buildJiraAlreadyLinkedModal,
  buildJiraNotConfiguredModal,
} = require("./blocks");
const jira = require("./jira");
const { rerankCandidates, classifyRouting } = require("./bedrock");
const { getJiraProjectConfig } = require("./jira-project-config");
const { searchAccounts } = require("./accounts");

const FEEDBACK_COMMAND = process.env.SLACK_FEEDBACK_COMMAND || "/logfeedback";
const BOT_DISPLAY_NAME = process.env.SLACK_BOT_DISPLAY_NAME || "Product Feedback Bot";
const JIRA_LABEL_PREFIX = process.env.JIRA_LABEL_PREFIX || "slack-feedback";

// Feature flag: defaults to enabled. Set DUPLICATE_DETECTION_ENABLED=false to
// kill the Jira+Bedrock search path without redeploying code paths.
const DUPLICATE_DETECTION_ENABLED =
  (process.env.DUPLICATE_DETECTION_ENABLED || "true").toLowerCase() !== "false";

// Classifier-driven routing nudge. Posts a thread reply suggesting a different
// product area when the LLM is at least this confident (0..1). Tunable without
// redeploy -- raise to reduce nudges, lower to catch more potential mis-routes.
function getRoutingConfidenceThreshold() {
  const raw = Number(process.env.ROUTING_CONFIDENCE_THRESHOLD);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return 0.75;
}

// Feature flag for the routing classifier itself. Defaults to on; set to
// `false` to disable even the classifier call (e.g. if Bedrock is unhealthy).
const ROUTING_NUDGE_ENABLED =
  (process.env.ROUTING_NUDGE_ENABLED || "true").toLowerCase() !== "false";

const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const EDGE_ORIGIN_VERIFY_HEADER_NAME = process.env.EDGE_ORIGIN_VERIFY_HEADER_NAME;
const EDGE_ORIGIN_VERIFY_SECRET = process.env.EDGE_ORIGIN_VERIFY_SECRET;

function getHeaderValue(headers, headerName) {
  if (!headers || !headerName) return undefined;

  const expectedHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expectedHeaderName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

function isAuthorizedEdgeRequest(headers) {
  if (!EDGE_ORIGIN_VERIFY_HEADER_NAME || !EDGE_ORIGIN_VERIFY_SECRET) return true;

  const providedSecret = getHeaderValue(headers, EDGE_ORIGIN_VERIFY_HEADER_NAME);
  if (typeof providedSecret !== "string") return false;

  const expected = Buffer.from(EDGE_ORIGIN_VERIFY_SECRET, "utf8");
  const provided = Buffer.from(providedSecret, "utf8");

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// DM the submitter when chat.postMessage failed because the bot isn't a
// member of the target channel. Best-effort: if the DM itself fails (rare),
// we just log -- the submitter will at least see the modal close cleanly.
async function notifyBotNotInChannel(client, userId, channelId, channelName) {
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text:
        `:warning: I couldn't post your feedback to <#${channelId}|${channelName}> ` +
        `because I'm not a member of that channel. Please run ` +
        `\`/invite @${BOT_DISPLAY_NAME}\` in #${channelName} and submit again.`,
    });
  } catch (ephemeralError) {
    // postEphemeral also requires channel membership, so it usually fails
    // here too. Fall back to a real DM.
    console.warn(
      `postEphemeral fallback for not_in_channel notification:`,
      ephemeralError.message
    );
    try {
      const dm = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: dm.channel.id,
        text:
          `:warning: I couldn't post your feedback to <#${channelId}|${channelName}> ` +
          `because I'm not a member of that channel. Please run ` +
          `\`/invite @${BOT_DISPLAY_NAME}\` in #${channelName} and submit again.`,
      });
    } catch (dmError) {
      console.error(
        `Failed to notify ${userId} about not_in_channel for ${channelId}:`,
        dmError.message
      );
    }
  }
}

// ─────────────────────────────────────────────
// Async self-invocation for post-submit background work.
// ─────────────────────────────────────────────

// Slack's view_submission ack deadline is 3s. With AwsLambdaReceiver running
// in processBeforeResponse mode (mandatory on Lambda), the HTTP response is
// only sent when the handler function resolves -- so every awaited operation
// in the handler counts toward that 3s, including cold-start container init,
// Secrets Manager fetch, DB pool warmup with IAM token signing, and any
// downstream API calls. Bolt JS does not support lazy listeners, so the
// canonical workaround is the two-phase pattern below.
//
// Foreground (this Lambda invocation, < 3s budget):
//   1. await ack()                       -- buffers the 200
//   2. in-memory dedup check (≪1ms)      -- catches warm-container resubmits
//   3. invokeBackgroundTask(...)         -- ~50-500ms for the AWS API call
//   4. return                            -- now the buffered 200 ships
//
// Background (separate async Lambda invocation, 30s budget):
//   1. claimViewSubmission(viewId)       -- DB-level dedup across containers
//   2. createFeedback                    -- DB write
//   3. chat.postMessage                  -- the actual feedback post
//   4. chat.getPermalink + updateFeedback
//   5. findAndPostDuplicates             -- Bedrock + Jira
//   6. postRoutingNudgeIfNeeded          -- Bedrock
//
// We intentionally moved chat.postMessage to the background even though the
// post is user-visible: the modal closes the moment ack is received, and a
// post that appears ~1-2s later is a much better UX than a modal that errors
// out while the post sneaks in behind it (which is what the inline path was
// producing). All branches that DM the submitter on failure (e.g.
// not_in_channel) still run from the background and target the original
// reporter via body.user.id.
const BACKGROUND_TASK_FEEDBACK_SUBMIT = "feedback_submission";

// In-memory dedup for warm-container fast-path. Slack auto-retries are
// caught at the Lambda edge, but a user-initiated resubmit (after seeing
// "something went wrong" in the still-open modal) lands as a fresh
// view_submission. If the same warm container handles it, this Set
// short-circuits before we even fire a background invocation. The DB claim
// inside the background task is the source of truth across containers.
const seenViewIds = new Set();
const SEEN_VIEW_IDS_MAX_SIZE = 1000;
function markViewSeen(viewId) {
  seenViewIds.add(viewId);
  if (seenViewIds.size > SEEN_VIEW_IDS_MAX_SIZE) {
    const oldest = seenViewIds.values().next().value;
    seenViewIds.delete(oldest);
  }
}

// Eager init so the first foreground invocation doesn't pay for SDK module
// load + credential provider setup inside the 3s ack window. The require()
// itself is the bulk of the cost (~100-300ms cold); constructing the
// client is cheap. Only initialize on Lambda -- local dev doesn't use it.
let lambdaClient = null;
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  try {
    const { LambdaClient } = require("@aws-sdk/client-lambda");
    lambdaClient = new LambdaClient({});
  } catch (error) {
    console.warn("Eager LambdaClient init failed:", error.message);
  }
}
function getLambdaClient() {
  if (lambdaClient) return lambdaClient;
  const { LambdaClient } = require("@aws-sdk/client-lambda");
  lambdaClient = new LambdaClient({});
  return lambdaClient;
}

async function invokeBackgroundTask(payload) {
  const fnName =
    process.env.BACKGROUND_LAMBDA_FUNCTION_NAME ||
    process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!fnName) {
    // Local/Socket Mode: just run the work inline. No ack-window pressure
    // here because there's no API Gateway in the loop.
    return runBackgroundTask(payload, getInProcessSlackClient());
  }
  try {
    const { InvokeCommand } = require("@aws-sdk/client-lambda");
    await getLambdaClient().send(
      new InvokeCommand({
        FunctionName: fnName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );
  } catch (error) {
    // Async self-invoke failed (IAM, throttling, network). Fall back to
    // running the work inline so we don't silently drop duplicate detection
    // and routing. This may push the ack past 3s, but a noisy modal is
    // strictly better than a missing duplicate hint.
    console.warn(
      "Background self-invoke failed; running post-submit work inline:",
      error.message
    );
    await runBackgroundTask(payload, getInProcessSlackClient());
  }
}

// Holds the in-process WebClient so background tasks invoked inline (local
// dev or self-invoke fallback) can post to Slack without a separate auth
// dance. Set inside the handler once we have access to `client`.
let inProcessSlackClient = null;
function setInProcessSlackClient(client) {
  inProcessSlackClient = client;
}
function getInProcessSlackClient() {
  return inProcessSlackClient;
}

// Background-task dispatcher. Called from the Lambda entry point when the
// incoming event is one of our self-invocations (identified by the
// `_backgroundTask` discriminator).
async function runBackgroundTask(payload, client) {
  if (!client) {
    console.warn("runBackgroundTask: no Slack client available; skipping");
    return;
  }
  const task = payload?._backgroundTask;
  if (task === BACKGROUND_TASK_FEEDBACK_SUBMIT) {
    return runFeedbackSubmission(payload, client);
  }
  console.warn(`runBackgroundTask: unknown task ${task}`);
}

// Full feedback-submission pipeline. Runs in the background invocation so
// the foreground can return inside Slack's 3s ack window. Carries the
// minimum payload extracted from the original view_submission so the
// background Lambda doesn't need access to the original Slack request.
async function runFeedbackSubmission(payload, client) {
  const { viewId, submission, channelId, channelName, reporterUserId } = payload;
  if (!viewId || !submission || !channelId || !reporterUserId) {
    console.warn("runFeedbackSubmission: missing required payload fields");
    return;
  }

  // DB-level claim. If another invocation already won the claim for this
  // view.id (e.g. user resubmitted on a cold container that didn't have
  // the in-memory mark) this returns false and we silently bail to avoid
  // a duplicate post.
  let claimed = true;
  try {
    claimed = await claimViewSubmission(viewId);
  } catch (claimError) {
    console.warn(
      `claimViewSubmission failed for view ${viewId}; proceeding anyway:`,
      claimError.message
    );
  }
  if (!claimed) {
    console.log(
      `Skipping duplicate feedback submission for view ${viewId} (already claimed)`
    );
    return;
  }

  const {
    customer, title, description, replay, type, urgency, customFieldValues,
  } = submission;
  const config = getChannelConfig(channelId);

  let reporterName;
  try {
    const reporterInfo = await client.users.info({ user: reporterUserId });
    reporterName = reporterInfo.user.real_name || reporterInfo.user.name;
  } catch (error) {
    // users.info failure is non-fatal -- the post still works with the
    // user's ID. Log so we notice if Slack starts rate-limiting us here.
    console.warn(`users.info failed for ${reporterUserId}:`, error.message);
    reporterName = reporterUserId;
  }

  const record = await createFeedback({
    channelId,
    productArea: config.name,
    reporterUserId,
    reporterName,
    customer,
    title,
    type,
    urgency,
    description,
    replay,
    customFields: customFieldValues,
    assignedPmUserId: config.pmUserId,
    assignedPmName: config.pmName,
  });

  const postBlocks = buildFeedbackPost({
    feedbackId: record.id, customer, title, type, urgency, description, replay,
    customFields: customFieldValues,
    customFieldDefs: config.customFields || [],
    reporterUserId,
    pmUserId: config.pmUserId,
    productArea: config.name,
  });

  let result;
  try {
    result = await client.chat.postMessage({
      channel: channelId,
      blocks: postBlocks,
      text: `New feedback from ${reporterName}: ${customer} - ${title}`,
    });
  } catch (error) {
    // Most common operator-side failure: the bot was never invited to the
    // channel (or got removed). The user already saw the modal close
    // successfully, so DM them to explain what happened and how to fix.
    if (error?.data?.error === "not_in_channel") {
      console.warn(
        `chat.postMessage failed: bot is not a member of channel ${channelId} (#${channelName})`
      );
      try {
        await deleteFeedback(record.id);
      } catch (deleteError) {
        console.warn(
          `Failed to delete orphan feedback ${record.id} after not_in_channel:`,
          deleteError.message
        );
      }
      await notifyBotNotInChannel(client, reporterUserId, channelId, channelName);
      return;
    }
    console.error(`chat.postMessage failed for ${record.id}:`, error);
    throw error;
  }

  let slackPermalink = null;
  try {
    const pl = await client.chat.getPermalink({
      channel: channelId,
      message_ts: result.ts,
    });
    slackPermalink = pl.permalink || null;
  } catch (error) {
    console.warn(`getPermalink failed for ${record.id}:`, error.message);
  }

  await updateFeedback(record.id, {
    threadTs: result.ts,
    messageTs: result.ts,
    postBlocks,
    slackPermalink,
  });
  console.log(`Feedback ${record.id} posted to #${channelName} (ts: ${result.ts})`);

  // Bedrock-bound work runs after the post is up so chat.update has a
  // target. Both helpers are idempotent and swallow their own errors.
  await findAndPostDuplicates(record.id, client);
  await postRoutingNudgeIfNeeded(record.id, client);
}

// ─────────────────────────────────────────────
// Pure helpers (module-scoped so they're cheap and testable)
// ─────────────────────────────────────────────

// Convert a free-text product area name (e.g. "AI Studio") into a
// Jira-label-safe slug (e.g. "ai-studio"). Jira labels can't contain spaces;
// lowercasing keeps filters case-insensitive in practice.
function slugifyForLabel(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Async duplicate-detection pass. Runs after the channel post is up so the
// modal ack stays fast; failures are swallowed so a flaky Jira/Bedrock call
// never breaks the primary feedback flow. Idempotent on the feedback record:
// if suggestions are already stored or a Jira ticket is already linked, exits.
async function findAndPostDuplicates(feedbackId, client) {
  if (!DUPLICATE_DETECTION_ENABLED) return;
  if (!jira.isInitialized()) return;

  try {
    const record = await getFeedback(feedbackId);
    if (!record) return;
    if (record.jiraTicket) return;
    if (record.duplicateSuggestions && record.duplicateSuggestions.length > 0) return;
    if (record.duplicateSuggestionsDismissedAt) return;

    const sub = record.submission || {};
    // Scope the recall pass of the duplicate search to whatever Jira context
    // the channel declares (project / team / extra JQL). Without it the
    // search falls back to all of Jira; the precision pass on
    // `labels = ${JIRA_LABEL_PREFIX}` runs either way.
    const channelConfig = getChannelConfig(record.channelId);
    const candidates = await jira.searchSimilarTickets({
      title: sub.title,
      description: sub.description,
      scope: channelConfig.jiraSearch || {},
    });
    if (!candidates || candidates.length === 0) {
      console.log(`Duplicate detection ${feedbackId}: no JQL candidates`);
      return;
    }

    const ranked = await rerankCandidates({
      feedback: { title: sub.title, description: sub.description },
      candidates,
    });
    if (!ranked || ranked.length === 0) {
      console.log(`Duplicate detection ${feedbackId}: no matches above threshold`);
      return;
    }

    // Merge rerank scores back onto the Jira metadata so the Block Kit
    // builder has summary/status/url alongside score/reason.
    const candidatesByKey = new Map(candidates.map((c) => [c.key, c]));
    const matches = ranked
      .map((r) => {
        const meta = candidatesByKey.get(r.key);
        if (!meta) return null;
        return {
          key: meta.key,
          url: meta.url,
          summary: meta.summary,
          status: meta.status,
          score: r.score,
          reason: r.reason,
        };
      })
      .filter(Boolean);

    if (matches.length === 0) return;

    // Persist first so a duplicate posting attempt (Lambda retry) is a no-op.
    await updateFeedback(feedbackId, { duplicateSuggestions: matches });

    const reply = await client.chat.postMessage({
      channel: record.channelId,
      thread_ts: record.threadTs,
      blocks: buildDuplicateSuggestionsBlocks({ feedbackId, matches }),
      text: `Possible duplicates: ${matches.map((m) => m.key).join(", ")}`,
    });

    // Update the original channel post with a subtle hint pointing at the
    // top match. Stored postBlocks let us re-render without rebuilding.
    if (record.postBlocks && record.messageTs) {
      try {
        const top = matches[0];
        const updatedBlocks = applyDuplicateHintToBlocks(record.postBlocks, {
          key: top.key,
          url: top.url,
        });
        await client.chat.update({
          channel: record.channelId,
          ts: record.messageTs,
          blocks: updatedBlocks,
          text: `Possible duplicate: ${top.key}`,
        });
        await updateFeedback(feedbackId, {
          postBlocks: updatedBlocks,
          duplicateSuggestionsMessageTs: reply.ts,
        });
      } catch (error) {
        console.warn(
          `Duplicate hint chat.update failed for ${feedbackId}:`,
          error.message
        );
        // Still record the thread-message ts so dismiss can find it.
        await updateFeedback(feedbackId, {
          duplicateSuggestionsMessageTs: reply.ts,
        });
      }
    } else {
      await updateFeedback(feedbackId, {
        duplicateSuggestionsMessageTs: reply.ts,
      });
    }

    console.log(
      `Duplicate detection ${feedbackId}: posted ${matches.length} match(es): ${matches.map((m) => `${m.key}(${Math.round(m.score * 100)}%)`).join(", ")}`
    );
  } catch (error) {
    console.error(`Duplicate detection failed for ${feedbackId}:`, error);
  }
}

// Returns the channelId matching a product-area name, or null. The classifier
// is prompted with the same area names we expose in channel-config, so this
// lookup is usually a hit. Picks the first match if somehow duplicated.
function findChannelIdByAreaName(areaName) {
  for (const [id, cfg] of Object.entries(channelConfig)) {
    if (cfg.name === areaName) return id;
  }
  return null;
}

// Set of every userId configured as a PM for any channel. Used to gate the
// Reroute action to configured PMs only.
function getConfiguredPmUserIds() {
  const ids = new Set();
  for (const cfg of Object.values(channelConfig)) {
    if (cfg.pmUserId) ids.add(cfg.pmUserId);
  }
  return ids;
}

// Best-effort channel name resolver with a small in-memory cache. Safe to fail
// (we fall back to the channelId itself so the message still renders).
const channelNameCache = new Map();
async function resolveChannelName(client, channelId) {
  if (!channelId) return null;
  if (channelNameCache.has(channelId)) return channelNameCache.get(channelId);
  try {
    const info = await client.conversations.info({ channel: channelId });
    const name = info.channel?.name || channelId;
    channelNameCache.set(channelId, name);
    return name;
  } catch (error) {
    console.warn(`conversations.info failed for ${channelId}:`, error.message);
    return channelId;
  }
}

// Async classifier pass. Runs after the channel post exists so the modal ack
// stays fast; failures are swallowed so a flaky Bedrock call never breaks the
// primary flow. Idempotent on the record: if a nudge was already posted, exits.
async function postRoutingNudgeIfNeeded(feedbackId, client) {
  if (!ROUTING_NUDGE_ENABLED) return;

  try {
    const record = await getFeedback(feedbackId);
    if (!record) return;
    if (record.routingNudgeMessageTs) return;
    if (record.routingNudgeDismissedAt) return;
    if (record.rerouteHistory && record.rerouteHistory.length > 0) return;

    const sub = record.submission || {};
    const areas = Object.values(channelConfig)
      .filter((cfg) => cfg.name && cfg.name !== "Feedback Testing")
      .map((cfg) => ({ name: cfg.name, description: cfg.description || "" }));

    if (areas.length < 2) return;

    const suggestion = await classifyRouting({
      feedback: {
        title: sub.title,
        description: sub.description,
        customer: sub.customer,
        type: sub.type,
      },
      areas,
    });

    if (!suggestion) return;

    const threshold = getRoutingConfidenceThreshold();
    if (suggestion.confidence < threshold) {
      console.log(
        `Routing nudge ${feedbackId}: classifier suggested ${suggestion.area} @ ${Math.round(
          suggestion.confidence * 100
        )}% -- below threshold (${Math.round(threshold * 100)}%), skipping`
      );
      return;
    }

    if (suggestion.area === record.productArea) {
      console.log(
        `Routing nudge ${feedbackId}: classifier agrees with channel (${suggestion.area}), skipping`
      );
      return;
    }

    const targetChannelId = findChannelIdByAreaName(suggestion.area);
    if (!targetChannelId) {
      console.log(
        `Routing nudge ${feedbackId}: classifier suggested ${suggestion.area} but no matching channel configured`
      );
      return;
    }

    const currentConfig = getChannelConfig(record.channelId);
    const targetConfig = getChannelConfig(targetChannelId);
    const [currentChannelName, targetChannelName] = await Promise.all([
      resolveChannelName(client, record.channelId),
      resolveChannelName(client, targetChannelId),
    ]);

    const nudgeBlocks = buildRoutingNudgeBlocks({
      feedbackId,
      suggestion,
      currentConfig,
      currentChannelId: record.channelId,
      currentChannelName,
      targetConfig,
      targetChannelId,
      targetChannelName,
    });

    const reply = await client.chat.postMessage({
      channel: record.channelId,
      thread_ts: record.threadTs,
      blocks: nudgeBlocks,
      text: `Possible mis-route: this looks like ${suggestion.area} feedback.`,
    });

    await updateFeedback(feedbackId, {
      routingNudgeMessageTs: reply.ts,
      routingSuggestion: {
        area: suggestion.area,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        targetChannelId,
        at: new Date().toISOString(),
      },
    });

    console.log(
      `Routing nudge ${feedbackId}: posted suggestion ${suggestion.area} @ ${Math.round(
        suggestion.confidence * 100
      )}%`
    );
  } catch (error) {
    console.error(`Routing nudge failed for ${feedbackId}:`, error);
  }
}

// Cross-post flow for moving a feedback item to the correct channel after a
// mis-route. Steps:
//   1. Post the full feedback to the target channel with a "Rerouted from..."
//      banner.
//   2. Mark the original post as moved (prepend banner, strip action buttons).
//   3. Delete stale duplicate / routing-nudge thread replies.
//   4. Update the record: channelId, productArea, assignedPm, threadTs,
//      messageTs, slackPermalink, postBlocks, rerouteHistory.
//   5. DM the previous PM (best effort).
//   6. Refresh both PMs' Home tabs (best effort).
// Returns { ok: true } on success, or { ok: false, error } on a recoverable
// failure (e.g. not_in_channel). Throws on unexpected errors.
async function performReroute({ feedbackId, toChannelId, actingUserId, reason, client }) {
  const record = await getFeedback(feedbackId);
  if (!record) return { ok: false, error: "Feedback not found." };
  if (record.channelId === toChannelId) {
    return { ok: false, error: "Already routed to that channel." };
  }

  const toConfig = getChannelConfig(toChannelId);
  if (!toConfig || !toConfig.pmUserId) {
    return { ok: false, error: "Target channel is not configured." };
  }

  const fromChannelId = record.channelId;
  const fromConfig = getChannelConfig(fromChannelId);
  const fromPmUserId = record.assignedPm?.userId || fromConfig.pmUserId || null;

  const [fromChannelName, toChannelName] = await Promise.all([
    resolveChannelName(client, fromChannelId),
    resolveChannelName(client, toChannelId),
  ]);

  const sub = record.submission || {};
  const newBaseBlocks = buildFeedbackPost({
    feedbackId: record.id,
    customer: sub.customer,
    title: sub.title,
    type: sub.type,
    urgency: sub.urgency,
    description: sub.description,
    replay: sub.replay,
    customFields: sub.customFields || {},
    customFieldDefs: toConfig.customFields || [],
    reporterUserId: record.reporter?.userId,
    pmUserId: toConfig.pmUserId,
    productArea: toConfig.name,
    jiraTicket: record.jiraTicket || null,
  });

  const reroutedBanner = buildReroutedFromBanner({
    fromChannelId,
    fromChannelName,
    oldPermalink: record.slackPermalink,
    actingUserId,
    reason,
  });
  const newPostBlocks = [reroutedBanner, ...newBaseBlocks];

  let postResult;
  try {
    postResult = await client.chat.postMessage({
      channel: toChannelId,
      blocks: newPostBlocks,
      text: `Rerouted feedback from #${fromChannelName}: ${sub.customer || ""}${sub.title ? ` - ${sub.title}` : ""}`,
    });
  } catch (error) {
    if (error?.data?.error === "not_in_channel") {
      console.warn(
        `Reroute chat.postMessage failed: bot is not a member of target channel ${toChannelId} (#${toChannelName})`
      );
      try {
        await client.chat.postMessage({
          channel: actingUserId,
          text:
            `:warning: I couldn't reroute feedback to <#${toChannelId}|${toChannelName}> because I'm not a member of that channel. ` +
            `Invite me with \`/invite @${BOT_DISPLAY_NAME}\` in that channel and try again.`,
        });
      } catch (dmError) {
        console.warn(`Failed to DM ${actingUserId} about not_in_channel:`, dmError.message);
      }
      return { ok: false, error: `I'm not a member of #${toChannelName}. Invite me there and try again.` };
    }
    throw error;
  }

  let newPermalink = null;
  try {
    const pl = await client.chat.getPermalink({
      channel: toChannelId,
      message_ts: postResult.ts,
    });
    newPermalink = pl.permalink || null;
  } catch (error) {
    console.warn(`Reroute getPermalink failed for ${feedbackId}:`, error.message);
  }

  // Update the original post in place: strip action buttons, prepend a
  // "Moved to..." banner so nobody actions this stale copy.
  if (record.messageTs && record.postBlocks) {
    try {
      const movedBanner = buildMovedBanner({
        toChannelId,
        toChannelName,
        newPermalink,
      });
      const updatedOldBlocks = applyMovedBannerAndStripActions(
        record.postBlocks,
        feedbackId,
        movedBanner
      );
      await client.chat.update({
        channel: fromChannelId,
        ts: record.messageTs,
        blocks: updatedOldBlocks,
        text: `Moved to #${toChannelName}`,
      });
    } catch (error) {
      console.warn(
        `Reroute chat.update of original post failed for ${feedbackId}:`,
        error.message
      );
    }
  }

  // Best-effort cleanup of stale thread replies on the original post.
  for (const ts of [record.routingNudgeMessageTs, record.duplicateSuggestionsMessageTs]) {
    if (!ts) continue;
    try {
      await client.chat.delete({ channel: fromChannelId, ts });
    } catch (error) {
      if (error?.data?.error !== "message_not_found") {
        console.warn(`Reroute thread cleanup delete failed:`, error.message);
      }
    }
  }

  const historyEntry = {
    from: { channelId: fromChannelId, productArea: fromConfig.name, pmUserId: fromPmUserId },
    to: { channelId: toChannelId, productArea: toConfig.name, pmUserId: toConfig.pmUserId },
    actingUserId,
    reason: reason || null,
    at: new Date().toISOString(),
  };

  await updateFeedback(feedbackId, {
    channelId: toChannelId,
    productArea: toConfig.name,
    assignedPm: { userId: toConfig.pmUserId, name: toConfig.pmName || null },
    threadTs: postResult.ts,
    messageTs: postResult.ts,
    slackPermalink: newPermalink,
    postBlocks: newPostBlocks,
    rerouteHistory: [...(record.rerouteHistory || []), historyEntry],
    // Clear thread-reply pointers since those live on the old post.
    routingNudgeMessageTs: null,
    duplicateSuggestionsMessageTs: null,
  });

  // Notify the previous PM so they know the item left their queue.
  if (fromPmUserId && fromPmUserId !== toConfig.pmUserId && fromPmUserId !== actingUserId) {
    try {
      const link = newPermalink ? ` <${newPermalink}|View new thread>.` : "";
      await client.chat.postMessage({
        channel: fromPmUserId,
        text:
          `:arrows_counterclockwise: Feedback \`${feedbackId}\` was rerouted to *${toConfig.name}* ` +
          `(<#${toChannelId}|${toChannelName}>) by <@${actingUserId}>.${link} No action needed from you.`,
      });
    } catch (error) {
      console.warn(`Reroute DM to previous PM ${fromPmUserId} failed:`, error.message);
    }
  }

  return { ok: true, newChannelId: toChannelId, newPermalink, fromPmUserId, toPmUserId: toConfig.pmUserId };
}

// Pull the user's currently-typed text inputs out of live view state so we
// can pass them back into buildJiraTicketModal on a re-render. Without this,
// every views.update would clobber edits back to their auto-seeded versions.
function extractModalInitialValues(viewState) {
  const v = viewState?.values || {};
  return {
    summary: v.jira_summary_block?.jira_summary_input?.value ?? null,
    description: v.jira_description_block?.jira_description_input?.value ?? null,
    priority:
      v.jira_priority_block?.jira_priority_select?.selected_option?.value ?? null,
    labels: v.jira_labels_block?.jira_labels_input?.value ?? null,
    context: v.jira_context_block?.jira_context_input?.value ?? null,
  };
}

// Pull the user's currently-selected dropdown picks out of live view state.
// Used so a re-render preserves whatever Team / Parent the PM picked even if
// they trigger the re-render afterward (e.g. switching issue type after
// picking a Team). private_metadata can be stale here -- view.state.values
// is always live.
function extractModalSelections(viewState) {
  const v = viewState?.values || {};
  return {
    parentKey:
      v.jira_parent_block?.jira_parent_select?.selected_option?.value ?? null,
    teamId:
      v.jira_team_block?.jira_team_select?.selected_option?.value ?? null,
  };
}

function registerHandlers(app) {

  app.command(FEEDBACK_COMMAND, async ({ ack, body, client }) => {
    await ack();
    try {
      const channelInfo = await client.conversations.info({ channel: body.channel_id });
      const channelName = channelInfo.channel.name;
      const config = getChannelConfig(body.channel_id);
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          ...buildFeedbackModal(channelName, config.customFields || []),
          private_metadata: JSON.stringify({ channelId: body.channel_id, channelName }),
        },
      });
    } catch (error) {
      console.error("Error opening feedback modal:", error);
    }
  });

  app.options("customer_select", async ({ options, ack }) => {
    try {
      const matches = searchAccounts(options.value || "");
      await ack({
        options: matches.map((name) => ({
          text: { type: "plain_text", text: name },
          value: name,
        })),
      });
    } catch (error) {
      console.error("Error searching accounts:", error);
      await ack({ options: [] });
    }
  });

  app.view("feedback_modal_submit", async ({ ack, body, view, client }) => {
    // The foreground path is intentionally minimal: ack, dedup-by-view-id
    // in memory, fire an async self-invocation with the extracted payload,
    // return. Everything else (DB writes, chat.postMessage, Bedrock) runs
    // in runFeedbackSubmission on the background invocation. This keeps
    // the handler comfortably under Slack's 3s ack window even on a cold
    // container, so the user never sees "something went wrong" and the
    // duplicate-resubmit path goes away.
    await ack();

    if (seenViewIds.has(view.id)) {
      console.log(
        `Skipping duplicate feedback_modal_submit for view ${view.id} (in-memory dedup)`
      );
      return;
    }
    markViewSeen(view.id);

    setInProcessSlackClient(client);
    try {
      // Extract everything the background task will need. We can't pass the
      // raw view/body across an async Lambda invocation reliably (size,
      // and Slack's payloads contain enums we don't need), so we lift the
      // submission shape here and forward it explicitly.
      const values = view.state.values;
      const { channelId, channelName } = JSON.parse(view.private_metadata);
      const config = getChannelConfig(channelId);

      const customFieldValues = {};
      for (const field of config.customFields || []) {
        const block = values[field.blockId];
        if (block && block[field.actionId]) {
          customFieldValues[field.blockId] = field.type === "static_select"
            ? block[field.actionId].selected_option?.value || null
            : block[field.actionId].value || null;
        }
      }

      const submission = {
        customer:
          values.customer_block.customer_select.selected_option?.value ||
          "Not specified",
        title: values.title_block.title_input.value,
        description: values.description_block.description_input.value,
        replay: values.replay_block?.replay_input?.value || null,
        type: values.type_block.type_select.selected_option.value,
        urgency: values.urgency_block.urgency_select.selected_option.value,
        customFieldValues,
      };

      await invokeBackgroundTask({
        _backgroundTask: BACKGROUND_TASK_FEEDBACK_SUBMIT,
        viewId: view.id,
        submission,
        channelId,
        channelName,
        reporterUserId: body.user.id,
      });
    } catch (error) {
      console.error("Error dispatching feedback submission:", error);
    }
  });

  app.action("feedback_respond", async ({ ack, body, client }) => {
    await ack();
    try {
      const feedbackId = body.actions[0].value;
      const record = await getFeedback(feedbackId);
      if (!record) return;
      const summary = `${record.submission.customer}: ${record.submission.title || record.submission.description.slice(0, 200)}`;
      await client.views.open({ trigger_id: body.trigger_id, view: buildResponseModal(feedbackId, summary) });
    } catch (error) {
      console.error("Error opening response modal:", error);
    }
  });

  app.action("home_respond", async ({ ack, body, client }) => {
    await ack();
    try {
      const feedbackId = body.actions[0].value;
      const record = await getFeedback(feedbackId);
      if (!record) return;
      const summary = `${record.submission.customer}: ${record.submission.title || record.submission.description.slice(0, 200)}`;
      await client.views.open({ trigger_id: body.trigger_id, view: buildResponseModal(feedbackId, summary) });
    } catch (error) {
      console.error("Error opening response modal from Home tab:", error);
    }
  });

  app.view("feedback_response_submit", async ({ ack, body, view, client }) => {
    await ack();
    try {
      const feedbackId = view.private_metadata;
      const record = await getFeedback(feedbackId);
      if (!record) return;

      const responseText = view.state.values.response_block.response_input.value;
      const newStatus = view.state.values.status_block.status_select.selected_option.value;

      await updateFeedback(feedbackId, {
        status: newStatus,
        pmRespondedAt: new Date().toISOString(),
        responseTimeHours: ((Date.now() - new Date(record.createdAt).getTime()) / 3600000).toFixed(1),
      });

      await client.chat.postMessage({
        channel: record.channelId,
        thread_ts: record.threadTs,
        text: `:speech_balloon: *Response from <@${body.user.id}>:*\n${responseText}\n\n_Status updated to: ${newStatus.replace("_", " ")}_`,
      });
      console.log(`Feedback ${feedbackId} responded to, status -> ${newStatus}`);
    } catch (error) {
      console.error("Error posting response:", error);
    }
  });

  async function publishHomeTab(userId, client) {
    // Fan out the three independent fetches in parallel: user info + pending +
    // responded. Drops Home tab open from ~6 sequential round trips to ~3
    // parallel ones.
    const [userInfo, pendingItems, respondedItems] = await Promise.all([
      client.users.info({ user: userId }),
      getByPm(userId, { status: "pending" }),
      getRespondedByPm(userId),
    ]);
    const userName = userInfo.user.real_name || userInfo.user.name;

    await client.views.publish({
      user_id: userId,
      view: buildHomeTab({
        userName,
        userId,
        pendingItems,
        respondedItems,
        isAdmin: false,
      }),
    });
  }

  app.event("app_home_opened", async ({ event, client }) => {
    try {
      await publishHomeTab(event.user, client);
    } catch (error) {
      console.error("Error publishing Home tab:", error);
    }
  });

  // ── Jira integration handlers ──

  async function openJiraModal(feedbackId, triggerId, client) {
    // Fail fast if the Jira client was never initialized -- otherwise the PM
    // gets a working-looking modal whose project picker silently returns nothing.
    if (!jira.isInitialized()) {
      console.warn("Jira modal requested but Jira client is not initialized.");
      await client.views.open({
        trigger_id: triggerId,
        view: buildJiraNotConfiguredModal(),
      });
      return;
    }

    const record = await getFeedback(feedbackId);
    if (!record) {
      console.error(`Feedback ${feedbackId} not found for Jira modal`);
      return;
    }

    // Block duplicate ticket creation -- show an info modal with the link.
    if (record.jiraTicket) {
      await client.views.open({
        trigger_id: triggerId,
        view: buildJiraAlreadyLinkedModal(record.jiraTicket),
      });
      return;
    }

    // Best-effort permalink for "click in Jira -> see Slack thread" flow.
    let slackPermalink = null;
    if (record.channelId && (record.messageTs || record.threadTs)) {
      try {
        const result = await client.chat.getPermalink({
          channel: record.channelId,
          message_ts: record.messageTs || record.threadTs,
        });
        slackPermalink = result.permalink || null;
      } catch (error) {
        console.warn("getPermalink failed (continuing without Slack link):", error.message);
      }
    }

    // Pre-seed the Project (and Team, when the project requires one) from
    // the channel's `jiraSearch` config. Each Slack channel already declares
    // "tickets from here belong in <project>, owned by <team>" for the
    // duplicate-detection recall pass; reusing it here means the PM opens
    // the modal with the right project/team already selected instead of
    // hunting through a 45-project alphabetical list to find e.g. WE.
    //
    // Team is only seeded when the resolved project actually requires one
    // (jira-project-config -> requiresTeam). For projects without a Team
    // field projectConfig is null and the
    // Team picker doesn't render, so any stray channel-level teamId is
    // silently ignored -- which is the right behavior.
    const channelCfg = getChannelConfig(record.channelId);
    const defaultProjectKey =
      channelCfg?.jiraSearch?.projectKeys?.[0] || null;
    const defaultProjectConfig = defaultProjectKey
      ? getJiraProjectConfig(defaultProjectKey)
      : null;
    const defaultTeamId = defaultProjectConfig?.requiresTeam
      ? channelCfg?.jiraSearch?.teamId || null
      : null;

    await client.views.open({
      trigger_id: triggerId,
      view: buildJiraTicketModal(feedbackId, record, {
        slackPermalink,
        projectKey: defaultProjectKey,
        projectConfig: defaultProjectConfig,
        teamId: defaultTeamId,
      }),
    });
  }

  app.action("home_create_jira_ticket", async ({ ack, body, client }) => {
    await ack();
    try {
      const feedbackId = body.actions[0].value;
      await openJiraModal(feedbackId, body.trigger_id, client);
    } catch (error) {
      console.error("Error opening Jira modal from Home tab:", error);
    }
  });

  app.action("channel_create_jira_ticket", async ({ ack, body, client }) => {
    await ack();
    try {
      const feedbackId = body.actions[0].value;
      await openJiraModal(feedbackId, body.trigger_id, client);
    } catch (error) {
      console.error("Error opening Jira modal from channel post:", error);
    }
  });

  // External options for project search -- used by the Jira project picker.
  app.options("jira_project_select", async ({ options, ack }) => {
    if (!jira.isInitialized()) {
      console.warn("jira_project_select called but Jira client is not initialized.");
      return ack({ options: [] });
    }
    try {
      const projects = await jira.searchProjects(options.value || "");
      console.log(
        `Jira project search query=${JSON.stringify(options.value || "")} -> ${projects.length} result(s)`
      );
      await ack({
        options: projects.map((p) => ({
          text: { type: "plain_text", text: `${p.key} — ${p.name}` },
          value: p.key,
        })),
      });
    } catch (error) {
      console.error(
        `Jira project search failed (query=${JSON.stringify(options.value || "")}):`,
        error.message || error
      );
      await ack({ options: [] });
    }
  });

  // External options for issue types -- driven by the project chosen above
  // (carried in private_metadata). Falls back to a static list if the call
  // fails or the project hasn't been picked yet.
  app.options("jira_issue_type_select", async ({ options, ack }) => {
    if (!jira.isInitialized()) {
      return ack({ options: [] });
    }
    try {
      const meta = JSON.parse(options.view?.private_metadata || "{}");
      if (!meta.projectKey) {
        return ack({ options: [] });
      }

      const types = await jira.getIssueTypesForProject(meta.projectKey);
      const filter = (options.value || "").toLowerCase();
      const filtered = filter
        ? types.filter((t) => t.name.toLowerCase().includes(filter))
        : types;

      console.log(
        `Jira issue types for project=${meta.projectKey} -> ${types.length} type(s), ${filtered.length} after filter=${JSON.stringify(filter)}`
      );

      await ack({
        options: filtered.slice(0, 50).map((t) => ({
          text: { type: "plain_text", text: t.name },
          value: t.name,
        })),
      });
    } catch (error) {
      console.error("Error loading Jira issue types:", error.message || error);
      await ack({ options: [] });
    }
  });

  // When the PM picks a project, rebuild the modal so the Issue Type dropdown
  // becomes a project-aware external_select. Resets issue type + parent since
  // both are project-scoped and would be invalid for the new project.
  app.action("jira_project_select", async ({ ack, body, client }) => {
    await ack();
    try {
      const meta = JSON.parse(body.view.private_metadata || "{}");
      const newProjectKey = body.actions[0].selected_option?.value;
      if (!newProjectKey || newProjectKey === meta.projectKey) return;

      const record = await getFeedback(meta.feedbackId);
      if (!record) return;

      await client.views.update({
        view_id: body.view.id,
        hash: body.view.hash,
        view: buildJiraTicketModal(meta.feedbackId, record, {
          slackPermalink: meta.slackPermalink,
          projectKey: newProjectKey,
          // Project changed -- previous issue type / parent / team no longer
          // valid (team list is project-scoped).
          selectedIssueType: null,
          parentKey: null,
          teamId: null,
          projectConfig: getJiraProjectConfig(newProjectKey),
          initialValues: extractModalInitialValues(body.view.state),
        }),
      });
    } catch (error) {
      console.error("Error updating Jira modal after project select:", error);
    }
  });

  // When the PM picks an issue type, rebuild so the Parent Epic block shows
  // (for Story/Task/Bug/Spike) or hides (for Epic/Sub-task/Initiative).
  app.action("jira_issue_type_select", async ({ ack, body, client }) => {
    await ack();
    try {
      const meta = JSON.parse(body.view.private_metadata || "{}");
      const newIssueType = body.actions[0].selected_option?.value;
      if (!newIssueType || newIssueType === meta.selectedIssueType) return;

      const record = await getFeedback(meta.feedbackId);
      if (!record) return;

      // Read live selections so anything the PM picked since the modal opened
      // (Team, Parent) survives the re-render. Falling back to meta would
      // lose selections made between renders.
      const live = extractModalSelections(body.view.state);

      await client.views.update({
        view_id: body.view.id,
        hash: body.view.hash,
        view: buildJiraTicketModal(meta.feedbackId, record, {
          slackPermalink: meta.slackPermalink,
          projectKey: meta.projectKey,
          selectedIssueType: newIssueType,
          parentKey: live.parentKey,
          teamId: live.teamId,
          projectConfig: getJiraProjectConfig(meta.projectKey),
          initialValues: extractModalInitialValues(body.view.state),
        }),
      });
    } catch (error) {
      console.error("Error updating Jira modal after issue type select:", error);
    }
  });

  // Team picker doesn't change the modal layout -- just ack so Slack stops
  // showing the loading spinner. Selected value is read at submit time.
  app.action("jira_team_select", async ({ ack }) => {
    await ack();
  });

  // External options for the Parent Epic picker. Searches open Epics in the
  // currently-selected project. Slack enforces min_query_length=2 client-side,
  // so this only fires once the PM has typed enough characters.
  app.options("jira_parent_select", async ({ options, ack }) => {
    if (!jira.isInitialized()) {
      return ack({ options: [] });
    }
    try {
      const meta = JSON.parse(options.view?.private_metadata || "{}");
      if (!meta.projectKey) {
        return ack({ options: [] });
      }

      const epics = await jira.searchEpics(meta.projectKey, options.value || "");
      console.log(
        `Jira epic search project=${meta.projectKey} query=${JSON.stringify(options.value || "")} -> ${epics.length} result(s)`
      );

      // Slack option text is capped at 75 chars -- truncate summaries safely.
      await ack({
        options: epics.slice(0, 25).map((e) => {
          const label = `${e.key} — ${e.summary}`;
          return {
            text: {
              type: "plain_text",
              text: label.length > 75 ? label.slice(0, 72) + "..." : label,
            },
            value: e.key,
          };
        }),
      });
    } catch (error) {
      console.error("Jira epic search failed:", error.message || error);
      await ack({ options: [] });
    }
  });

  // ── Duplicate-detection action handlers ──

  // PM accepted a suggested duplicate. Links the existing Jira ticket onto
  // the feedback row, marks it resolved, swaps the channel post (removes
  // "Create Jira Ticket", strips the duplicate hint, appends the Jira link
  // context), confirms in-thread, and refreshes the PM's Home tab.
  app.action("resolve_as_duplicate", async ({ ack, body, client }) => {
    await ack();
    try {
      const raw = body.actions[0].value || "";
      const sep = raw.indexOf("::");
      if (sep < 0) {
        console.warn("resolve_as_duplicate: malformed value:", raw);
        return;
      }
      const feedbackId = raw.slice(0, sep);
      const jiraKey = raw.slice(sep + 2);

      const record = await getFeedback(feedbackId);
      if (!record) {
        console.warn(`resolve_as_duplicate: feedback ${feedbackId} not found`);
        return;
      }
      if (record.jiraTicket) {
        // Already linked (race / double-click). Nothing to do.
        console.log(
          `resolve_as_duplicate: ${feedbackId} already linked to ${record.jiraTicket.key}`
        );
        return;
      }

      // The URL came back from Jira on the original search; pull it from the
      // stored suggestions rather than re-querying or guessing the base URL.
      const match = (record.duplicateSuggestions || []).find((m) => m.key === jiraKey);
      if (!match) {
        console.warn(
          `resolve_as_duplicate: ${jiraKey} not in stored suggestions for ${feedbackId}`
        );
        return;
      }

      const ticket = {
        key: match.key,
        url: match.url,
        matchedAutomatically: true,
        resolvedFromDuplicateAt: new Date().toISOString(),
      };

      const updated = await updateFeedback(feedbackId, {
        jiraTicket: ticket,
        status: "resolved",
        pmRespondedAt: record.pmRespondedAt || new Date().toISOString(),
        responseTimeHours:
          record.responseTimeHours ||
          ((Date.now() - new Date(record.createdAt).getTime()) / 3600000).toFixed(1),
      });

      // Swap the channel post: drop Create Jira button + duplicate hint,
      // append the Jira link context. Reuses the existing helper so the
      // visual end-state matches the manual create flow.
      if (record.channelId && record.messageTs && record.postBlocks) {
        try {
          const updatedBlocks = applyJiraTicketToFeedbackBlocks(
            record.postBlocks,
            feedbackId,
            ticket
          );
          await client.chat.update({
            channel: record.channelId,
            ts: record.messageTs,
            blocks: updatedBlocks,
            text: `Feedback resolved as duplicate of ${ticket.key}`,
          });
          await updateFeedback(feedbackId, { postBlocks: updatedBlocks });
        } catch (error) {
          console.warn(
            `resolve_as_duplicate: chat.update failed for ${feedbackId}:`,
            error.message
          );
        }
      }

      // Confirmation in-thread for the reporter.
      if (record.channelId && record.threadTs) {
        try {
          await client.chat.postMessage({
            channel: record.channelId,
            thread_ts: record.threadTs,
            text: `:white_check_mark: Resolved as duplicate of <${ticket.url}|${ticket.key}> by <@${body.user.id}>`,
          });
        } catch (error) {
          console.warn(
            `resolve_as_duplicate: thread reply failed for ${feedbackId}:`,
            error.message
          );
        }
      }

      // Refresh the PM Home tab so the new state shows up without reopen.
      const pmUserId = updated?.assignedPm?.userId || record.assignedPm?.userId;
      if (pmUserId) {
        try {
          await publishHomeTab(pmUserId, client);
        } catch (error) {
          console.warn(
            `resolve_as_duplicate: publishHomeTab failed for ${feedbackId}:`,
            error.message
          );
        }
      }

      console.log(
        `Feedback ${feedbackId} resolved as duplicate of ${ticket.key} by ${body.user.id}`
      );
    } catch (error) {
      console.error("Error resolving as duplicate:", error);
    }
  });

  // PM said "not a duplicate" -- record dismissal, remove the in-thread
  // suggestion message, and strip the subtle hint from the channel post.
  app.action("dismiss_duplicate_suggestions", async ({ ack, body, client }) => {
    await ack();
    try {
      const feedbackId = body.actions[0].value;
      const record = await getFeedback(feedbackId);
      if (!record) return;

      await updateFeedback(feedbackId, {
        duplicateSuggestionsDismissedAt: new Date().toISOString(),
      });

      // Delete the suggestions thread message (best effort -- if the user
      // already deleted it, we just log).
      if (record.channelId && record.duplicateSuggestionsMessageTs) {
        try {
          await client.chat.delete({
            channel: record.channelId,
            ts: record.duplicateSuggestionsMessageTs,
          });
        } catch (error) {
          console.warn(
            `dismiss_duplicate_suggestions: chat.delete failed for ${feedbackId}:`,
            error.message
          );
        }
      }

      // Strip the subtle hint from the original channel post.
      if (record.channelId && record.messageTs && record.postBlocks) {
        try {
          const updatedBlocks = removeDuplicateHintFromBlocks(record.postBlocks);
          await client.chat.update({
            channel: record.channelId,
            ts: record.messageTs,
            blocks: updatedBlocks,
            text: record.submission?.title
              ? `Feedback: ${record.submission.title}`
              : "Feedback updated",
          });
          await updateFeedback(feedbackId, { postBlocks: updatedBlocks });
        } catch (error) {
          console.warn(
            `dismiss_duplicate_suggestions: chat.update failed for ${feedbackId}:`,
            error.message
          );
        }
      }

      console.log(
        `Duplicate suggestions dismissed for ${feedbackId} by ${body.user.id}`
      );
    } catch (error) {
      console.error("Error dismissing duplicate suggestions:", error);
    }
  });

  app.view("jira_ticket_submit", async ({ ack, body, view, client }) => {
    let feedbackId;
    let projectKey;
    let issueTypeName;

    try {
      const meta = JSON.parse(view.private_metadata || "{}");
      feedbackId = meta.feedbackId;

      const values = view.state.values;
      projectKey = values.jira_project_block.jira_project_select.selected_option?.value;
      issueTypeName = values.jira_issue_type_block.jira_issue_type_select.selected_option?.value;
      const summary = values.jira_summary_block.jira_summary_input.value;
      const priority = values.jira_priority_block.jira_priority_select.selected_option.value;
      const labelsRaw = values.jira_labels_block?.jira_labels_input?.value || "";
      const additionalContext = values.jira_context_block?.jira_context_input?.value || "";
      // Parent block only renders for parent-eligible issue types, so its
      // absence is normal -- not an error.
      const parentKey =
        values.jira_parent_block?.jira_parent_select?.selected_option?.value || null;
      // Team block only renders for projects that require it. teamFieldId
      // comes from private_metadata so we don't have to re-resolve config.
      const teamId =
        values.jira_team_block?.jira_team_select?.selected_option?.value || null;
      const teamFieldId = meta.teamFieldId || null;

      let description = values.jira_description_block.jira_description_input.value;
      if (additionalContext) {
        description += "\n\n--- PM Context ---\n" + additionalContext;
      }

      const userLabels = labelsRaw
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);

      // Always tag tickets created via the feedback bot so PMs can find
      // them with a single JQL filter (`labels = ${JIRA_LABEL_PREFIX}`) and avoid
      // losing them in larger backlogs. Per-channel sub-label gives them
      // a sharper filter scoped to their product area.
      const record = await getFeedback(feedbackId);
      const autoLabels = [JIRA_LABEL_PREFIX];
      if (record?.productArea) {
        autoLabels.push(`${JIRA_LABEL_PREFIX}-${slugifyForLabel(record.productArea)}`);
      }
      // Dedupe and preserve user-typed labels.
      const labels = [...new Set([...autoLabels, ...userLabels])];

      const ticket = await jira.createIssue({
        projectKey,
        issueTypeName,
        summary,
        description,
        priority,
        labels,
        parentKey,
        teamFieldId,
        teamId,
      });

      // Jira create succeeded -- close the modal.
      await ack();
      const updated = await updateFeedback(feedbackId, {
        jiraTicket: { key: ticket.key, url: ticket.url },
      });

      // Audit trail in the thread for the original reporter.
      if (record && record.channelId && record.threadTs) {
        await client.chat.postMessage({
          channel: record.channelId,
          thread_ts: record.threadTs,
          text: `:ticket: Jira ticket created: <${ticket.url}|${ticket.key}> (${projectKey} · ${issueTypeName})\nCreated by <@${body.user.id}>`,
        });
      }

      // Update the original channel post: append Jira link, drop "Create Jira"
      // button. Requires we stored postBlocks + messageTs at submit time.
      if (record && record.channelId && record.messageTs && record.postBlocks) {
        try {
          const updatedBlocks = applyJiraTicketToFeedbackBlocks(
            record.postBlocks,
            feedbackId,
            { key: ticket.key, url: ticket.url }
          );
          await client.chat.update({
            channel: record.channelId,
            ts: record.messageTs,
            blocks: updatedBlocks,
            text: `Feedback linked to Jira ${ticket.key}`,
          });
          await updateFeedback(feedbackId, { postBlocks: updatedBlocks });
        } catch (error) {
          console.warn("chat.update of original feedback post failed:", error.message);
        }
      }

      // Refresh the assigned PM's Home tab so the new Jira link shows up
      // without them needing to reopen the app.
      const pmUserId = updated?.assignedPm?.userId || record?.assignedPm?.userId;
      if (pmUserId) {
        try {
          await publishHomeTab(pmUserId, client);
        } catch (error) {
          console.warn("publishHomeTab after Jira create failed:", error.message);
        }
      }

      console.log(`Jira ticket ${ticket.key} created for feedback ${feedbackId}`);
    } catch (error) {
      console.error("Error creating Jira ticket:", error);
      const message = (error && error.message) ? error.message : "Unknown error";
      // Heuristic: pin the error to the most relevant block so the PM knows
      // where to fix it. Team errors win first (most likely root cause when
      // they happen), then parent, then fall back to summary.
      const lower = message.toLowerCase();
      const teamRelated = lower.includes("team");
      const parentRelated = lower.includes("parent") || lower.includes("epic");
      let errorBlockId = "jira_summary_block";
      if (teamRelated && view.state.values.jira_team_block) {
        errorBlockId = "jira_team_block";
      } else if (parentRelated && view.state.values.jira_parent_block) {
        errorBlockId = "jira_parent_block";
      }
      try {
        await ack({
          response_action: "errors",
          errors: {
            [errorBlockId]: `Jira create failed: ${message.slice(0, 250)}`,
          },
        });
      } catch (ackErr) {
        console.error("Failed to ack with error response:", ackErr);
      }
    }
  });

  // ── Reroute handlers ──────────────────────────────

  // Shared opener used by every entry point (channel post button, Home tab
  // button, classifier nudge button). Enforces the PM-only permission check
  // centrally so the three action handlers below stay thin.
  async function openRerouteModal({ ack, body, client, feedbackId, suggestedChannelId = null }) {
    await ack();
    try {
      const actingUserId = body.user?.id;
      const pmSet = getConfiguredPmUserIds();
      if (!pmSet.has(actingUserId)) {
        try {
          await client.chat.postMessage({
            channel: actingUserId,
            text:
              ":lock: Only configured PMs can reroute feedback. If you think a feedback item is in the wrong channel, ping the assigned PM.",
          });
        } catch (dmError) {
          console.warn("Reroute permission DM failed:", dmError.message);
        }
        return;
      }

      const record = await getFeedback(feedbackId);
      if (!record) {
        console.warn(`Reroute open: feedback ${feedbackId} not found`);
        return;
      }

      const currentConfig = getChannelConfig(record.channelId);
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildRerouteModal({
          feedbackId,
          currentChannelId: record.channelId,
          currentConfig,
          channelConfig,
          suggestedChannelId,
        }),
      });
    } catch (error) {
      console.error("Error opening reroute modal:", error);
    }
  }

  app.action("feedback_reroute", async (args) => {
    const feedbackId = args.body.actions[0].value;
    await openRerouteModal({ ...args, feedbackId });
  });

  app.action("home_reroute", async (args) => {
    const feedbackId = args.body.actions[0].value;
    await openRerouteModal({ ...args, feedbackId });
  });

  app.action("routing_nudge_reroute", async (args) => {
    const raw = args.body.actions[0].value || "";
    // Packed as "feedbackId::suggestedChannelId" so we can pre-select the
    // target in the modal without an extra record lookup on the caller side.
    const [feedbackId, suggestedChannelId] = raw.split("::");
    await openRerouteModal({
      ...args,
      feedbackId,
      suggestedChannelId: suggestedChannelId || null,
    });
  });

  app.action("routing_nudge_dismiss", async ({ ack, body, client }) => {
    await ack();
    try {
      const feedbackId = body.actions[0].value;
      const pmSet = getConfiguredPmUserIds();
      if (!pmSet.has(body.user?.id)) return;

      const record = await getFeedback(feedbackId);
      if (!record) return;

      if (record.channelId && record.routingNudgeMessageTs) {
        try {
          await client.chat.delete({
            channel: record.channelId,
            ts: record.routingNudgeMessageTs,
          });
        } catch (error) {
          if (error?.data?.error !== "message_not_found") {
            console.warn(`routing_nudge_dismiss delete failed:`, error.message);
          }
        }
      }

      await updateFeedback(feedbackId, {
        routingNudgeMessageTs: null,
        routingNudgeDismissedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error dismissing routing nudge:", error);
    }
  });

  app.view("feedback_reroute_submit", async ({ ack, body, view, client }) => {
    try {
      const meta = JSON.parse(view.private_metadata || "{}");
      const feedbackId = meta.feedbackId;
      const toChannelId =
        view.state.values.reroute_target_block?.reroute_target_select?.selected_option?.value ||
        null;
      const reason =
        view.state.values.reroute_reason_block?.reroute_reason_input?.value || null;

      if (!feedbackId || !toChannelId) {
        await ack({
          response_action: "errors",
          errors: {
            reroute_target_block: "Pick a target product area.",
          },
        });
        return;
      }

      const actingUserId = body.user?.id;
      const pmSet = getConfiguredPmUserIds();
      if (!pmSet.has(actingUserId)) {
        await ack({
          response_action: "errors",
          errors: {
            reroute_target_block: "Only configured PMs can reroute feedback.",
          },
        });
        return;
      }

      // Validate target config *before* closing the modal so the PM gets
      // inline feedback if something's off.
      const record = await getFeedback(feedbackId);
      if (!record) {
        await ack({
          response_action: "errors",
          errors: { reroute_target_block: "Feedback not found." },
        });
        return;
      }
      if (record.channelId === toChannelId) {
        await ack({
          response_action: "errors",
          errors: { reroute_target_block: "That's already the current channel." },
        });
        return;
      }

      await ack();

      const result = await performReroute({
        feedbackId,
        toChannelId,
        actingUserId,
        reason,
        client,
      });

      if (!result.ok) {
        try {
          await client.chat.postMessage({
            channel: actingUserId,
            text: `:warning: Reroute failed: ${result.error}`,
          });
        } catch (dmError) {
          console.warn("Reroute failure DM failed:", dmError.message);
        }
        return;
      }

      // Refresh both PMs' Home tabs so the moved item disappears from the old
      // and appears on the new without requiring a manual reopen.
      for (const uid of [result.fromPmUserId, result.toPmUserId]) {
        if (!uid) continue;
        try {
          await publishHomeTab(uid, client);
        } catch (error) {
          console.warn(`publishHomeTab after reroute failed for ${uid}:`, error.message);
        }
      }

      console.log(
        `Reroute ${feedbackId}: ${record.channelId} -> ${toChannelId} by ${actingUserId}`
      );
    } catch (error) {
      console.error("Error in feedback_reroute_submit:", error);
      try {
        await ack({
          response_action: "errors",
          errors: {
            reroute_target_block: `Reroute failed: ${(error.message || "unknown").slice(0, 200)}`,
          },
        });
      } catch (ackErr) {
        console.error("Failed to ack reroute error:", ackErr);
      }
    }
  });
}

// ─────────────────────────────────────────────
// Lambda: lazy init with Secrets Manager fetch
// ─────────────────────────────────────────────

// Normalize API Gateway v2 events for AwsLambdaReceiver.
// Fixes: base64 body decoding (ascii->utf8), missing headers, path normalization.
function normalizeEvent(event) {
  // Decode base64 body with utf-8 (Bolt uses ascii which corrupts URL-encoded data)
  if (event.isBase64Encoded && event.body) {
    event.body = Buffer.from(event.body, "base64").toString("utf-8");
    event.isBase64Encoded = false;
  }

  // Ensure headers object exists
  if (!event.headers) event.headers = {};

  // API Gateway v2 uses requestContext.http instead of v1's httpMethod/path
  if (event.requestContext && event.requestContext.http) {
    if (!event.httpMethod) event.httpMethod = event.requestContext.http.method;
    if (!event.path) event.path = event.requestContext.http.path;
  }

  return event;
}

if (isLambda) {
  const { loadSecrets } = require("./secrets");
  let handlerFn;

  module.exports.handler = async (event, context, callback) => {
    context.callbackWaitsForEmptyEventLoop = false;

    // Branch 1: async self-invocation for post-submit background work.
    // These events come from lambda.Invoke (InvocationType=Event), not API
    // Gateway, so they don't carry edge headers, signing secrets, or
    // request bodies. They're our own payloads, identified by the
    // _backgroundTask discriminator. We still need secrets/Jira/Slack
    // initialized to do the work, so this branch shares the same lazy
    // init below.
    if (event && event._backgroundTask) {
      console.log(`Handling background task: ${event._backgroundTask}`);
      const secrets = await loadSecrets();
      if (secrets.JIRA_BASE_URL && secrets.JIRA_USER_EMAIL && secrets.JIRA_API_TOKEN) {
        jira.init({
          baseUrl: secrets.JIRA_BASE_URL,
          email: secrets.JIRA_USER_EMAIL,
          apiToken: secrets.JIRA_API_TOKEN,
        });
      }
      // We don't need the Bolt receiver here -- just a WebClient to post
      // to Slack. Using the same token Bolt would have used.
      const { WebClient } = require("@slack/web-api");
      const slackClient = new WebClient(secrets.SLACK_BOT_TOKEN);
      try {
        await runBackgroundTask(event, slackClient);
      } catch (error) {
        // Background invocations are async (no caller waiting). Log and
        // return success so Lambda doesn't retry on its own dead-letter
        // queue policy -- the helpers are idempotent but a retry storm
        // would still spam Bedrock.
        console.error(`Background task ${event._backgroundTask} failed:`, error);
      }
      return { statusCode: 200, body: "" };
    }

    console.log("Incoming event path:", event.rawPath || event.path || "unknown");
    console.log("Content-Type:", event.headers?.["content-type"] || "none");
    console.log("isBase64Encoded:", event.isBase64Encoded);

    const normalized = normalizeEvent(event);
    if (!isAuthorizedEdgeRequest(normalized.headers)) {
      return {
        statusCode: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Forbidden" }),
      };
    }

    // Slack retries any interaction it doesn't see a 200 for within ~3s,
    // up to 3 times. We can't usefully re-process a retry (the original
    // is still in flight or already finished), so ack with 200 and bail
    // here at the edge so the retry never reaches Bolt.
    //
    // Two layers of defense run inside the feedback_modal_submit pipeline
    // for retries that slip past this header check (e.g. user-initiated
    // resubmits after Slack shows "something went wrong" -- those are
    // fresh view_submissions without retry headers but with the same
    // view.id):
    //   1. seenViewIds in-memory Set in the foreground handler -- catches
    //      resubmits handled by the same warm container with no DB hit.
    //   2. claimViewSubmission() in runFeedbackSubmission (background
    //      invocation) -- DB-level INSERT ... ON CONFLICT keyed on view_id;
    //      source of truth across containers.
    const retryNum = getHeaderValue(normalized.headers, "x-slack-retry-num");
    if (retryNum) {
      const retryReason = getHeaderValue(normalized.headers, "x-slack-retry-reason");
      console.log(
        `Ignoring Slack retry (num=${retryNum} reason=${retryReason || "unknown"})`
      );
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: "",
      };
    }

    // Always reload secrets (cached with TTL inside loadSecrets) so rotated
    // Jira credentials get re-applied without a redeploy. Slack receiver/app
    // are initialized once because they hold network state -- rotating Slack
    // secrets still requires a redeploy/cold-start.
    const secrets = await loadSecrets();

    if (secrets.JIRA_BASE_URL && secrets.JIRA_USER_EMAIL && secrets.JIRA_API_TOKEN) {
      jira.init({
        baseUrl: secrets.JIRA_BASE_URL,
        email: secrets.JIRA_USER_EMAIL,
        apiToken: secrets.JIRA_API_TOKEN,
      });
    }

    if (!handlerFn) {
      if (!secrets.JIRA_BASE_URL || !secrets.JIRA_USER_EMAIL || !secrets.JIRA_API_TOKEN) {
        console.warn(
          `Jira secrets not configured -- ticket creation will be unavailable. Present: BASE_URL=${!!secrets.JIRA_BASE_URL} EMAIL=${!!secrets.JIRA_USER_EMAIL} TOKEN=${!!secrets.JIRA_API_TOKEN}`
        );
      } else {
        console.log(`Jira initialized: baseUrl=${secrets.JIRA_BASE_URL} user=${secrets.JIRA_USER_EMAIL}`);
      }

      const receiver = new AwsLambdaReceiver({
        signingSecret: secrets.SLACK_SIGNING_SECRET,
      });

      const app = new App({
        token: secrets.SLACK_BOT_TOKEN,
        receiver,
      });

      registerHandlers(app);
      handlerFn = await receiver.start();
    }
    return await handlerFn(normalized, context, callback);
  };
} else {
  if (process.env.JIRA_BASE_URL && process.env.JIRA_USER_EMAIL && process.env.JIRA_API_TOKEN) {
    jira.init({
      baseUrl: process.env.JIRA_BASE_URL,
      email: process.env.JIRA_USER_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
    });
  }

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  registerHandlers(app);

  (async () => {
    await app.start();
    console.log(`${BOT_DISPLAY_NAME} is running (Socket Mode)`);
  })();
}
