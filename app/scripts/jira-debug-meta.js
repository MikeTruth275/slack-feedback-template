#!/usr/bin/env node
// One-off diagnostic: prints which fields Jira requires when creating an
// issue in a given project, for each issue type. Use this to figure out
// whether mandatory custom fields (e.g. "Team") will block our creates
// from Slack and, if so, what their custom field IDs and value shapes are.
//
// Usage:
//   cd app
//   JIRA_BASE_URL=... JIRA_USER_EMAIL=... JIRA_API_TOKEN=... \
//     node scripts/jira-debug-meta.js PROD
//
// Or with a .env file in app/, just:
//   node scripts/jira-debug-meta.js PROD

require("dotenv").config();

const projectKey = process.argv[2];
if (!projectKey) {
  console.error("Usage: node scripts/jira-debug-meta.js <PROJECT_KEY>");
  console.error("Example: node scripts/jira-debug-meta.js PROD");
  process.exit(1);
}

const { JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN } = process.env;
if (!JIRA_BASE_URL || !JIRA_USER_EMAIL || !JIRA_API_TOKEN) {
  console.error("Missing env vars. Need JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN.");
  console.error("Set them inline or put them in app/.env");
  process.exit(1);
}

const baseUrl = JIRA_BASE_URL.replace(/\/$/, "");
const authHeader =
  "Basic " + Buffer.from(`${JIRA_USER_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

async function jget(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira ${res.status} on ${path}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

function fmt(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

(async () => {
  console.log(`\n== Jira createmeta diagnostic for project ${projectKey} ==`);
  console.log(`baseUrl: ${baseUrl}`);
  console.log(`user:    ${JIRA_USER_EMAIL}`);

  // Step 1: list issue types in the project.
  let typesData;
  try {
    typesData = await jget(`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`);
  } catch (err) {
    console.error("\nFailed to fetch issue types:", err.message);
    console.error("\nLikely causes: project key wrong, account lacks 'Browse Projects' or 'Create Issues' permission, or API token invalid.");
    process.exit(2);
  }

  const issueTypes = (typesData.issueTypes || typesData.values || []).map((t) => ({
    id: t.id,
    name: t.name,
    subtask: !!t.subtask,
  }));

  if (issueTypes.length === 0) {
    console.warn("\nNo issue types returned. Account probably lacks 'Create Issues' permission in this project.");
    process.exit(2);
  }

  console.log(`\nIssue types found (${issueTypes.length}):`);
  for (const t of issueTypes) {
    console.log(`  - ${t.name} (id=${t.id})${t.subtask ? " [sub-task]" : ""}`);
  }

  // Step 2: for each issue type, fetch field metadata and list required fields.
  const allRequired = new Map(); // fieldKey -> { name, schema, sample, requiredIn: Set<typeName> }

  for (const t of issueTypes) {
    let fieldData;
    try {
      fieldData = await jget(
        `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${t.id}?maxResults=200`
      );
    } catch (err) {
      console.error(`\n  ! Could not fetch fields for ${t.name}: ${err.message}`);
      continue;
    }

    const fields = fieldData.fields || fieldData.values || [];
    const required = fields.filter((f) => f.required);

    console.log(`\n--- Issue Type: ${t.name} ---`);
    console.log(`  Total fields: ${fields.length}, Required: ${required.length}`);

    for (const f of required) {
      const key = f.fieldId || f.key || f.name;
      const schemaType = f.schema?.type || "unknown";
      const schemaCustom = f.schema?.custom || null;
      const allowed = f.allowedValues
        ? f.allowedValues.slice(0, 3).map((v) => v.name || v.value || v.id || fmt(v))
        : null;

      console.log(`    * ${f.name}`);
      console.log(`        fieldId: ${key}`);
      console.log(`        type:    ${schemaType}${schemaCustom ? ` (custom: ${schemaCustom.split(":").pop()})` : ""}`);
      if (allowed && allowed.length > 0) {
        console.log(`        sample allowed values: ${allowed.join(", ")}${f.allowedValues.length > 3 ? ` ...(+${f.allowedValues.length - 3} more)` : ""}`);
      }
      if (f.hasDefaultValue) {
        console.log(`        hasDefaultValue: true`);
      }

      if (!allRequired.has(key)) {
        allRequired.set(key, {
          name: f.name,
          schemaType,
          schemaCustom,
          requiredIn: new Set(),
          hasDefaultValue: f.hasDefaultValue,
          sampleAllowed: allowed,
        });
      }
      allRequired.get(key).requiredIn.add(t.name);
    }
  }

  // Step 3: summary table.
  console.log(`\n== Summary: every required field across all issue types ==`);
  for (const [key, info] of allRequired) {
    console.log(
      `  ${info.name.padEnd(28)} ${key.padEnd(28)} ${info.schemaType.padEnd(12)} required in: ${[...info.requiredIn].join(", ")}${info.hasDefaultValue ? "  [hasDefault]" : ""}`
    );
  }

  // Step 4: targeted answer for the "Team" question.
  console.log(`\n== Team field check ==`);
  const teamFields = [...allRequired.entries()].filter(([k, v]) =>
    /team/i.test(v.name) || k === "customfield_10001"
  );
  if (teamFields.length === 0) {
    console.log(`  No required field named "Team" found in project ${projectKey}.`);
    console.log(`  Slack ticket creation should work as long as we cover the other required fields above.`);
  } else {
    for (const [key, info] of teamFields) {
      console.log(`  Required Team field detected:`);
      console.log(`    name:     ${info.name}`);
      console.log(`    fieldId:  ${key}`);
      console.log(`    type:     ${info.schemaType}${info.schemaCustom ? ` (${info.schemaCustom})` : ""}`);
      console.log(`    required for issue types: ${[...info.requiredIn].join(", ")}`);
      console.log(`    has default value: ${info.hasDefaultValue ? "yes" : "no"}`);
    }
  }
})().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
