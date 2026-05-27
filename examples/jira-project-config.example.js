// Example Jira project config.
// Copy to app/src/jira-project-config.local.js and replace placeholders with
// values discovered from your Jira Cloud instance.

const TEAM_FIELD_ID = "customfield_00000";

const PROJECT_CONFIG = {
  PROD: {
    name: "Product Engineering",
    requiresTeam: true,
    teamFieldId: TEAM_FIELD_ID,
    teams: [
      { name: "Core Product", id: "00000000-0000-0000-0000-000000000000" },
      { name: "Platform", id: "11111111-1111-1111-1111-111111111111" },
    ],
  },
};

module.exports = { PROJECT_CONFIG, TEAM_FIELD_ID };
