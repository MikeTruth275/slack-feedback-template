#!/usr/bin/env node
// Connectivity / required-field test: actually creates a Jira issue using
// the same REST payload shape our app uses, so we can see whether the
// real "Create" screen (workflow validators, behaviors, etc.) accepts it
// even when /createmeta says no extra fields are required.
//
// The created issue is clearly labeled [DELETE ME] -- delete it in Jira
// after the test.
//
// Usage:
//   cd app
//   JIRA_BASE_URL=... JIRA_USER_EMAIL=... JIRA_API_TOKEN=... \
//     node scripts/jira-debug-create.js PROD Task
//
//   # With a parent epic:
//   node scripts/jira-debug-create.js PROD Task PROD-123
//
//   # Dry run (prints the payload, doesn't POST):
//   node scripts/jira-debug-create.js PROD Task --dry-run

require("dotenv").config();

const dryRun = process.argv.includes("--dry-run");

// Pull --team <uuid> and --team-shape <bare|object> out of argv before
// positional parsing.
function takeFlag(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  return val && !val.startsWith("--") ? val : null;
}
const teamId = takeFlag("--team");
const teamShape = takeFlag("--team-shape") || "bare"; // bare | object

const positional = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith("--")) return false;
  // skip values that follow a known flag
  const prev = arr[i - 1];
  if (prev === "--team" || prev === "--team-shape") return false;
  return true;
});
const [projectKey, issueTypeName, parentKey] = positional;

if (!projectKey || !issueTypeName) {
  console.error("Usage: node scripts/jira-debug-create.js <PROJECT_KEY> <ISSUE_TYPE_NAME> [PARENT_KEY] [--team <UUID>] [--team-shape bare|object] [--dry-run]");
  console.error("Examples:");
  console.error("  node scripts/jira-debug-create.js PROD Task");
  console.error("  node scripts/jira-debug-create.js PROD Task --team <team-uuid>");
  console.error("  node scripts/jira-debug-create.js PROD Task --team <uuid> --team-shape object");
  console.error("  node scripts/jira-debug-create.js PROD Task --dry-run");
  process.exit(1);
}

const { JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_BASE_URL || !JIRA_USER_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing env vars. Need JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN.");
  process.exit(1);
}

const baseUrl = JIRA_BASE_URL.replace(/\/$/, "");
const authHeader =
  "Basic " + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const summary = `[DELETE ME] feedback-agent connectivity test ${stamp}`;
const description = [
  "This is an automated diagnostic ticket created by scripts/jira-debug-create.js.",
  "It mirrors the exact REST payload shape used by the Slack Feedback Agent.",
  "",
  "Safe to delete.",
  "",
  `Created by: ${JIRA_USER_EMAIL}`,
  `Project: ${projectKey}`,
  `Issue type: ${issueTypeName}`,
  parentKey ? `Parent: ${parentKey}` : "(no parent)",
].join("\n");

// This payload mirrors app/src/jira.js -> createIssue() exactly.
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
  priority: { name: "Lowest" },
  labels: ["feedback-agent-test", "delete-me"],
};
if (parentKey) fields.parent = { key: parentKey };
// customfield_00000 is the Atlassian Teams field on your-org.atlassian.net.
// Try bare-string shape by default; if Jira complains, re-run with
// --team-shape object.
if (teamId) {
  fields[process.env.JIRA_TEAM_FIELD_ID || "customfield_00000"] = teamShape === "object" ? { id: teamId } : teamId;
}

const payload = { fields };

console.log("\n== Jira create-issue connectivity test ==");
console.log(`baseUrl: ${baseUrl}`);
console.log(`user:    ${JIRA_USER_EMAIL}`);
console.log(`project: ${projectKey}`);
console.log(`type:    ${issueTypeName}${parentKey ? `  parent=${parentKey}` : ""}`);
console.log(`summary: ${summary}`);
console.log(`\nPayload (sent as JSON body to POST /rest/api/3/issue):`);
console.log(JSON.stringify(payload, null, 2));

if (dryRun) {
  console.log("\n--dry-run set, not POSTing. Exiting.");
  process.exit(0);
}

(async () => {
  console.log("\nPOSTing to /rest/api/3/issue ...");
  const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch { /* not JSON */ }

  console.log(`\nHTTP ${res.status} ${res.statusText}`);

  if (res.ok && bodyJson?.key) {
    console.log(`\nSUCCESS -- created ${bodyJson.key}`);
    console.log(`URL: ${baseUrl}/browse/${bodyJson.key}`);
    console.log(`\n>>> CLEANUP: delete this ticket in Jira when you're done verifying.\n`);
    console.log(`Full response:`);
    console.log(JSON.stringify(bodyJson, null, 2));
    process.exit(0);
  }

  console.log(`\nFAILURE -- Jira rejected the create.`);
  console.log(`\nResponse body:`);
  console.log(bodyJson ? JSON.stringify(bodyJson, null, 2) : bodyText.slice(0, 2000));

  // Pull out the field-level errors (most useful bit)
  if (bodyJson?.errors && typeof bodyJson.errors === "object") {
    console.log(`\n== Required / rejected fields (parsed) ==`);
    for (const [field, msg] of Object.entries(bodyJson.errors)) {
      console.log(`  ${field}: ${msg}`);
    }
  }
  if (bodyJson?.errorMessages && Array.isArray(bodyJson.errorMessages)) {
    console.log(`\n== Top-level error messages ==`);
    for (const m of bodyJson.errorMessages) console.log(`  ${m}`);
  }

  console.log(`\nNext step: tell Jira admin which exact field IDs are blocking, or extend the Slack modal to set them.`);
  process.exit(2);
})().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
