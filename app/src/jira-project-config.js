// Optional per-project Jira configuration for required custom fields that are
// enforced by workflow validators rather than returned by createmeta.
//
// Keep real Jira custom field IDs and team UUIDs out of public repos. Copy
// examples/jira-project-config.example.js to app/src/jira-project-config.local.js
// when your Jira instance requires project-specific fields.

const TEAM_FIELD_ID = process.env.JIRA_TEAM_FIELD_ID || null;

function loadLocalProjectConfig() {
  try {
    // Optional, gitignored tenant config.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require("./jira-project-config.local");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") return {};
    console.warn("Failed to load jira-project-config.local.js:", error.message || error);
    return {};
  }
}

const loadedConfig = loadLocalProjectConfig();
const PROJECT_CONFIG = loadedConfig.PROJECT_CONFIG || loadedConfig.projectConfig || {};
const configuredTeamFieldId = loadedConfig.TEAM_FIELD_ID || TEAM_FIELD_ID;

function getJiraProjectConfig(projectKey) {
  if (!projectKey) return null;
  return PROJECT_CONFIG[projectKey] || null;
}

module.exports = { getJiraProjectConfig, TEAM_FIELD_ID: configuredTeamFieldId };
