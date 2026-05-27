// Example channel routing config.
// Copy to app/src/channel-config.local.js and replace all placeholder IDs with
// values from your Slack workspace and Jira instance.

const channelConfig = {
  C0XXXXXXXXX: {
    name: "Core Product",
    description: "Feedback about the primary product workflow.",
    pmUserId: "U0XXXXXXXXX",
    pmName: "Alex Product",
    customFields: [
      {
        blockId: "surface_block",
        actionId: "surface_select",
        label: "Product Surface",
        type: "static_select",
        optional: false,
        options: [
          { text: "Web app", value: "web_app" },
          { text: "API", value: "api" },
          { text: "Integration", value: "integration" },
        ],
      },
    ],
    jiraSearch: {
      projectKeys: ["PROD"],
      // teamId: "00000000-0000-0000-0000-000000000000",
      // teamFieldId: "customfield_00000",
      // extraJql: 'component = "Core Product"',
    },
  },
};

module.exports = { channelConfig };
