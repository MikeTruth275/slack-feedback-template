// Fetches Slack tokens from AWS Secrets Manager on Lambda cold start.
// Store secrets under SECRET_PREFIX in AWS Secrets Manager. Optional secret-sync
// tooling can write to the same prefix.

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const PREFIX = process.env.SECRET_PREFIX || "slack-feedback-template/dev/";

// Slack secrets must load or the app cannot run. Jira secrets are optional: if
// any Jira fetch throws (AccessDenied, wrong KMS, etc.), Promise.all used to
// reject the entire load and Lambda never responded to Slack.
const SLACK_SECRET_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
];

const JIRA_SECRET_KEYS = [
  "JIRA_BASE_URL",
  "JIRA_USER_EMAIL",
  "JIRA_API_TOKEN",
];

// 15-minute TTL so warm Lambda containers eventually pick up rotated secrets
// (Slack signing secret, Jira API token, etc.) without requiring a redeploy
// or forced cold start. Refreshes happen lazily on the next request after
// expiry; cost is one extra Secrets Manager fetch per container per 15 min.
const SECRET_TTL_MS = 15 * 60 * 1000;
let cached = null;
let cachedAt = 0;

async function fetchSecret(client, key) {
  try {
    const res = await client.send(
      new GetSecretValueCommand({ SecretId: `${PREFIX}${key}` })
    );
    return res.SecretString;
  } catch (err) {
    if (err.name === "ResourceNotFoundException") {
      return undefined;
    }
    throw err;
  }
}

async function fetchSecretLenient(client, key) {
  try {
    return await fetchSecret(client, key);
  } catch (err) {
    console.warn(
      `Optional secret ${key} failed (${err.name}): ${err.message}`
    );
    return undefined;
  }
}

async function loadSecrets() {
  if (cached && Date.now() - cachedAt < SECRET_TTL_MS) return cached;

  const client = new SecretsManagerClient();
  const secrets = {};

  await Promise.all(
    SLACK_SECRET_KEYS.map(async (key) => {
      secrets[key] = await fetchSecret(client, key);
    })
  );

  await Promise.all(
    JIRA_SECRET_KEYS.map(async (key) => {
      secrets[key] = await fetchSecretLenient(client, key);
    })
  );

  cached = secrets;
  cachedAt = Date.now();
  return cached;
}

module.exports = { loadSecrets };
