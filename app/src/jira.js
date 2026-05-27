// Jira Cloud REST API v3 client.
// Auth: Basic (email + API token) from Secrets Manager.
// Uses native fetch (Node.js 22).

const { TEAM_FIELD_ID } = require("./jira-project-config");

const JIRA_LABEL_PREFIX = process.env.JIRA_LABEL_PREFIX || "slack-feedback";

let jiraConfig = null;

function init({ baseUrl, email, apiToken }) {
  jiraConfig = {
    baseUrl: baseUrl.replace(/\/$/, ""),
    authHeader:
      "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64"),
  };
}

async function jiraFetch(path, options = {}) {
  if (!jiraConfig) throw new Error("Jira client not initialized. Call init() first.");

  const res = await fetch(`${jiraConfig.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: jiraConfig.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API ${res.status}: ${body}`);
  }

  return res.json();
}

// maxResults=50 (Jira's per-page max) so the empty-query default in the
// Slack project picker includes enough projects for most Jira instances.
async function searchProjects(query) {
  const params = new URLSearchParams({
    maxResults: "50",
    orderBy: "name",
    action: "browse",
  });
  if (query) params.set("query", query);

  const data = await jiraFetch(`/rest/api/3/project/search?${params}`);
  return (data.values || []).map((p) => ({
    key: p.key,
    name: p.name,
    id: p.id,
  }));
}

async function getIssueTypesForProject(projectKey) {
  const data = await jiraFetch(
    `/rest/api/3/issue/createmeta/${projectKey}/issuetypes`
  );
  return (data.issueTypes || data.values || []).map((t) => ({
    id: t.id,
    name: t.name,
  }));
}

async function createIssue({ projectKey, issueTypeName, summary, description, priority, labels, parentKey, teamFieldId, teamId }) {
  const fields = {
    project: { key: projectKey },
    issuetype: { name: issueTypeName },
    summary,
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: description }],
        },
      ],
    },
  };

  if (priority) fields.priority = { name: priority };
  if (labels && labels.length > 0) fields.labels = labels;
  // Parent link (Story/Task/Bug/Spike -> Epic). Cloud uses fields.parent for
  // the modern issue-type hierarchy on Premium tier.
  if (parentKey) fields.parent = { key: parentKey };
  // Atlassian Teams field is set as a bare-string UUID. Some Jira instances
  // accept { id: "uuid" } as well; this template sends the bare UUID string
  // because that works for Atlassian Teams fields in many Jira Cloud setups.
  if (teamFieldId && teamId) fields[teamFieldId] = teamId;

  const data = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });

  return {
    key: data.key,
    id: data.id,
    url: `${jiraConfig.baseUrl}/browse/${data.key}`,
  };
}

// Sanitize free-text user input for use inside a JQL string literal.
// JQL strings are double-quoted; we strip backslashes and double quotes
// rather than try to escape, so a query like `foo"bar` becomes `foobar`.
function sanitizeJqlString(value) {
  return String(value).replace(/[\\"]/g, "").trim();
}

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;

// Search open Epics in a project by key (exact) or summary (prefix).
// Uses the new /search/jql endpoint -- the legacy /search is deprecated.
async function searchEpics(projectKey, rawQuery) {
  if (!projectKey) return [];
  const query = sanitizeJqlString(rawQuery || "");

  // Always scope to the project, restrict to Epics, exclude Done.
  const clauses = [
    `project = "${projectKey}"`,
    `issuetype = Epic`,
    `statusCategory != Done`,
  ];

  if (query) {
    if (ISSUE_KEY_PATTERN.test(query.toUpperCase())) {
      clauses.push(`key = ${query.toUpperCase()}`);
    } else {
      // `summary ~ "foo*"` is a prefix-ish text match in JQL.
      clauses.push(`summary ~ "${query}*"`);
    }
  }

  const jql = clauses.join(" AND ") + " ORDER BY updated DESC";

  const params = new URLSearchParams({
    jql,
    fields: "summary,status",
    maxResults: "25",
  });

  const data = await jiraFetch(`/rest/api/3/search/jql?${params}`);
  return (data.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary || "(no summary)",
    status: i.fields?.status?.name || null,
  }));
}

// Common English stopwords + a few Jira/feedback-domain noise words. We strip
// these before building the JQL `text ~` clause so the search isn't dominated
// by uninformative tokens. Lowercased.
const SEARCH_STOPWORDS = new Set([
  "a", "an", "and", "or", "but", "the", "is", "are", "was", "were", "be",
  "been", "being", "in", "on", "at", "to", "for", "of", "with", "by",
  "from", "as", "into", "this", "that", "these", "those", "it", "its",
  "i", "we", "you", "they", "he", "she", "my", "our", "your", "their",
  "do", "does", "did", "have", "has", "had", "having", "will", "would",
  "should", "could", "can", "may", "might", "not", "no", "yes", "if",
  "then", "than", "so", "about", "what", "when", "where", "why", "how",
  "feedback", "customer", "user", "users", "request", "issue", "bug",
  "feature", "ticket", "please", "need", "needs", "want", "wants",
]);

// Extract a JQL-safe set of search tokens from free-text feedback. We keep
// alphanumeric tokens >=3 chars that aren't stopwords, dedupe, and cap at 12
// (any more and JQL becomes both noisier and more likely to hit Jira's
// limits).
function extractSearchTerms({ title, description }) {
  const raw = `${title || ""} ${(description || "").slice(0, 400)}`;
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !SEARCH_STOPWORDS.has(t));
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
    if (unique.length >= 12) break;
  }
  return unique;
}

// Project keys are uppercase letters/digits/underscores starting with a
// letter (Jira's own constraint). Used to validate scope.projectKeys before
// we splice them into JQL.
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;

// Atlassian Teams field UUIDs are standard UUID-shaped. Validating both
// project keys and team IDs before they hit JQL belt-and-suspenders the
// `sanitizeJqlString` quote-stripping further.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Build the optional set of JQL clauses that scope a duplicate search to a
// channel's Jira context (project / team / arbitrary clause). All inputs are
// validated against strict patterns; anything malformed is silently dropped
// rather than bubbled up as an error -- the caller would still want a search
// to run, just an unscoped one.
function buildScopeClauses(scope = {}) {
  const clauses = [];

  if (Array.isArray(scope.projectKeys) && scope.projectKeys.length > 0) {
    const safe = scope.projectKeys
      .map((k) => sanitizeJqlString(k).toUpperCase())
      .filter((k) => PROJECT_KEY_PATTERN.test(k));
    if (safe.length > 0) {
      clauses.push(`project IN (${safe.map((k) => `"${k}"`).join(", ")})`);
    }
  }

  if (scope.teamId) {
    const teamId = sanitizeJqlString(scope.teamId);
    const fieldId = scope.teamFieldId || TEAM_FIELD_ID;
    if (UUID_PATTERN.test(teamId) && /^[a-z0-9_]+$/i.test(fieldId)) {
      clauses.push(`"${fieldId}" = "${teamId}"`);
    }
  }

  // Escape hatch for any other JQL the channel wants to add (e.g.
  // `component = "AI Studio"`). Wrapped in parens so it ANDs cleanly. The
  // caller is trusted -- this only comes from channel-config.js, never user
  // input.
  if (typeof scope.extraJql === "string" && scope.extraJql.trim()) {
    clauses.push(`(${scope.extraJql.trim()})`);
  }

  return clauses;
}

// Search Jira for tickets that look like potential duplicates of a piece of
// feedback. Runs two passes in parallel and merges:
//
//   1. Precision -- tickets created via this Feedback Agent (`labels =
//      ${JIRA_LABEL_PREFIX}`).. Small, high-signal pool.
//   2. Recall    -- the channel's Jira scope (project / team / extraJql)
//      from `scope`. Falls back to all of Jira when no scope is configured.
//      This is the change that surfaces duplicates the PM hasn't already
//      logged through this workflow.
//
// Each pass first tries `statusCategory != Done` (favoring open work) and
// retries without the status filter on zero hits so already-shipped/closed
// dupes still surface. Results are merged with precision matches winning on
// key collisions, capped at 25 candidates total before the Bedrock rerank.
async function searchSimilarTickets({ title, description, scope = {} }) {
  if (!jiraConfig) return [];
  const terms = extractSearchTerms({ title, description });
  if (terms.length === 0) return [];

  // JQL `text ~ "foo OR bar OR baz"` does an OR text search across summary,
  // description, comments, etc. Wrapped in double quotes; tokens are already
  // sanitized by the alphanumeric-only filter above so no escaping needed.
  const textClause = `text ~ "${terms.join(" OR ")}"`;

  async function runQuery(baseClauses, extraClauses) {
    const jql =
      [...baseClauses, ...extraClauses, textClause].join(" AND ") +
      " ORDER BY updated DESC";

    const params = new URLSearchParams({
      jql,
      fields: "summary,status,labels,updated,assignee",
      maxResults: "20",
    });
    const data = await jiraFetch(`/rest/api/3/search/jql?${params}`);
    return (data.issues || []).map((i) => ({
      key: i.key,
      url: `${jiraConfig.baseUrl}/browse/${i.key}`,
      summary: i.fields?.summary || "(no summary)",
      status: i.fields?.status?.name || null,
      updatedAt: i.fields?.updated || null,
      labels: i.fields?.labels || [],
      assignee: i.fields?.assignee?.displayName || null,
    }));
  }

  async function runPass(baseClauses, label) {
    try {
      let results = await runQuery(baseClauses, ["statusCategory != Done"]);
      if (results.length === 0) {
        results = await runQuery(baseClauses, []);
      }
      return results;
    } catch (error) {
      // One pass failing (e.g. malformed scope clause Jira rejected) shouldn't
      // sink the other. Log and degrade.
      console.warn(
        `Jira ${label} search pass failed:`,
        error.message || error
      );
      return [];
    }
  }

  const scopeClauses = buildScopeClauses(scope);

  const [precisionMatches, recallMatches] = await Promise.all([
    runPass([`labels = ${JIRA_LABEL_PREFIX}`], "precision"),
    runPass(scopeClauses, "recall"),
  ]);

  // Dedupe by key. Precision matches first so they win on conflict (their
  // labels/metadata are slightly richer for downstream display).
  const seen = new Set();
  const merged = [];
  for (const r of [...precisionMatches, ...recallMatches]) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    merged.push(r);
    if (merged.length >= 25) break;
  }
  return merged;
}

function isInitialized() {
  return jiraConfig !== null;
}

module.exports = {
  init,
  isInitialized,
  searchProjects,
  getIssueTypesForProject,
  searchEpics,
  searchSimilarTickets,
  createIssue,
};
