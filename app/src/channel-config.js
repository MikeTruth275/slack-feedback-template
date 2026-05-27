// Channel routing configuration.
//
// Keep real Slack channel IDs and PM user IDs out of public repos. For your
// deployment, copy examples/channel-config.example.js to
// app/src/channel-config.local.js and fill in your workspace-specific values.

const DEFAULT_CONFIG = {
  name: process.env.DEFAULT_PRODUCT_AREA || "General",
  description: "Fallback area for channels that are not explicitly configured.",
  pmUserId: null,
  pmName: null,
  customFields: [],
};

function loadLocalChannelConfig() {
  try {
    // Optional, gitignored tenant config.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require("./channel-config.local");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") return {};
    console.warn("Failed to load channel-config.local.js:", error.message || error);
    return {};
  }
}

const loadedConfig = loadLocalChannelConfig();
const channelConfig = loadedConfig.channelConfig || loadedConfig || {};

function getChannelConfig(channelId) {
  return channelConfig[channelId] || DEFAULT_CONFIG;
}

module.exports = { channelConfig, getChannelConfig, DEFAULT_CONFIG };
