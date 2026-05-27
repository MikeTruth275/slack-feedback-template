#!/usr/bin/env node
// Diagnostic: discover the custom field ID and value shape for hidden
// required fields (e.g. "Team") that don't show up in /createmeta because
// they're enforced by workflow validators rather than field configuration.
//
// Usage:
//   cd app
//   JIRA_BASE_URL=... JIRA_USER_EMAIL=... JIRA_API_TOKEN=... \
//     node scripts/jira-debug-fields.js                   # list ALL fields matching "team"
//     node scripts/jira-debug-fields.js team              # filter by substring
//     node scripts/jira-debug-fields.js --list-teams      # enumerate Atlassian Teams
//     node scripts/jira-debug-fields.js --inspect PROD-123 # show every field on a real issue

require("dotenv").config();

const args = process.argv.slice(2);
const wantTeams = args.includes("--list-teams");
const inspectIdx = args.indexOf("--inspect");
const inspectKey = inspectIdx >= 0 ? args[inspectIdx + 1] : null;
const discoverIdx = args.indexOf("--discover-teams");
const discoverProject = discoverIdx >= 0 ? args[discoverIdx + 1] : null;
const filter = args.find((a) => !a.startsWith("--") && a !== inspectKey && a !== discoverProject) || "team";

const { JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_BASE_URL || !JIRA_USER_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing env vars. Need JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN.");
  process.exit(1);
}

const baseUrl = JIRA_BASE_URL.replace(/\/$/, "");
const authHeader =
  "Basic " + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

async function jget(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: authHeader, Accept: "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, body: json || text };
}

async function listFields(filterStr) {
  console.log(`\n== All Jira fields matching "${filterStr}" ==\n`);
  const r = await jget("/rest/api/3/field");
  if (!r.ok) {
    console.error(`HTTP ${r.status}:`, r.body);
    process.exit(2);
  }
  const matches = r.body.filter((f) =>
    [f.name, f.id, f.key, f.schema?.custom]
      .filter(Boolean)
      .some((s) => s.toLowerCase().includes(filterStr.toLowerCase()))
  );

  if (matches.length === 0) {
    console.log(`(no fields matched)`);
    return;
  }

  for (const f of matches) {
    console.log(`  ${f.name}`);
    console.log(`    id:           ${f.id}`);
    console.log(`    key:          ${f.key || "(same as id)"}`);
    console.log(`    custom:       ${f.custom ? "yes" : "no"}`);
    console.log(`    schema.type:  ${f.schema?.type || "(none)"}`);
    if (f.schema?.custom) console.log(`    schema.custom: ${f.schema.custom}`);
    if (f.schema?.items) console.log(`    schema.items: ${f.schema.items}`);
    console.log("");
  }
}

async function inspectIssue(key) {
  console.log(`\n== Inspecting fields on ${key} (use this to see real Team field values) ==\n`);
  // ?expand=names returns the human-readable field names mapped to ids.
  const r = await jget(`/rest/api/3/issue/${key}?expand=names,schema`);
  if (!r.ok) {
    console.error(`HTTP ${r.status}:`, r.body);
    process.exit(2);
  }
  const names = r.body.names || {};
  const schema = r.body.schema || {};
  const fields = r.body.fields || {};

  // Show only non-null fields, with name + id + value.
  const populated = Object.entries(fields).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0));
  console.log(`Populated fields (${populated.length}):\n`);
  for (const [id, value] of populated) {
    const name = names[id] || "(no name)";
    const sch = schema[id] || {};
    const valStr = typeof value === "object" ? JSON.stringify(value) : String(value);
    const trunc = valStr.length > 200 ? valStr.slice(0, 200) + " ..." : valStr;
    console.log(`  ${name.padEnd(28)} ${id.padEnd(28)} type=${sch.type || "?"}${sch.custom ? ` (${sch.custom.split(":").pop()})` : ""}`);
    console.log(`    value: ${trunc}\n`);
  }
}

async function listTeams() {
  console.log(`\n== Listing Atlassian Teams ==\n`);
  // Atlassian Teams Public API is hosted at the cloud-wide gateway, not the
  // site URL. We'll try a few known endpoints since Atlassian has shifted
  // them around. Note: the Teams API requires an OAuth scope that Basic
  // auth API tokens may not have -- if all four 401/403/404, we'll have
  // to fall back to discovering team IDs from a real issue.
  const candidates = [
    "/gateway/api/public/teams/v1/org/your-org",
    "/rest/api/3/team",
    "/rest/teams/1.0/team",
  ];
  for (const path of candidates) {
    const r = await jget(path);
    console.log(`  ${path} -> HTTP ${r.status}`);
    if (r.ok) {
      console.log(`    body (truncated):`);
      const s = typeof r.body === "object" ? JSON.stringify(r.body, null, 2) : r.body;
      console.log(s.slice(0, 1500));
      return;
    }
  }
  console.log(`\n  None of the team-list endpoints returned 200. This is common --`);
  console.log(`  Atlassian's Teams API requires OAuth scopes Basic-auth tokens don't have.`);
  console.log(`\n  Workaround: pick any existing issue that has a Team set and run:`);
  console.log(`    node scripts/jira-debug-fields.js --inspect PROD-123`);
  console.log(`  That'll show you the team value's exact shape -- usually { id: "uuid" }`);
  console.log(`  and you can grab valid team IDs from there.`);
}

async function discoverTeams(projectKey) {
  console.log(`\n== Discovering all unique Teams used in ${projectKey} (last 200 issues) ==\n`);

  // Use the JQL search endpoint and ask only for the Team field, sorted by
  // recently updated so we lean toward currently-active teams.
  const jql = `project = ${projectKey} AND "Team[Team]" is not EMPTY ORDER BY updated DESC`;
  const params = new URLSearchParams({
    jql,
    fields: process.env.JIRA_TEAM_FIELD_ID || "customfield_00000",
    maxResults: "200",
  });

  const r = await jget(`/rest/api/3/search/jql?${params}`);
  if (!r.ok) {
    console.error(`HTTP ${r.status}:`, typeof r.body === "object" ? JSON.stringify(r.body, null, 2) : r.body);
    process.exit(2);
  }

  const issues = r.body.issues || [];
  console.log(`Scanned ${issues.length} issues.\n`);

  const teams = new Map(); // id -> { name, count }
  for (const issue of issues) {
    const teamFieldId = process.env.JIRA_TEAM_FIELD_ID || "customfield_00000";
    const t = issue.fields?.[teamFieldId];
    if (!t) continue;
    // Field is type=team -- single object, not array.
    const id = t.id;
    const name = t.name || t.title || "(unnamed)";
    if (!id) continue;
    if (!teams.has(id)) teams.set(id, { name, count: 0 });
    teams.get(id).count += 1;
  }

  if (teams.size === 0) {
    console.log(`No Team values found in scanned issues.`);
    return;
  }

  // Sort by usage count desc.
  const sorted = [...teams.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`Found ${sorted.length} unique team(s):\n`);
  for (const [id, info] of sorted) {
    console.log(`  ${info.name.padEnd(40)} count=${String(info.count).padStart(3)}  id=${id}`);
  }

  console.log(`\nReady-to-paste config (drop into jira-project-config.js):\n`);
  console.log(`teams: [`);
  for (const [id, info] of sorted) {
    console.log(`  { name: ${JSON.stringify(info.name)}, id: ${JSON.stringify(id)} },`);
  }
  console.log(`],`);
}

(async () => {
  if (wantTeams) {
    await listTeams();
    return;
  }
  if (discoverProject) {
    await discoverTeams(discoverProject);
    return;
  }
  if (inspectKey) {
    await inspectIssue(inspectKey);
    return;
  }
  await listFields(filter);
})().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
