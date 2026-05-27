# Setup Guide

Use this checklist when creating a new Slack feedback app from the template.

## 1. Rename The Project

Update names that should match your repo or product:

- `Pulumi.yaml` project name
- `pyproject.toml` project name
- `app/package.json` package name
- `catalog-info.yaml`, if you use Backstage
- `README.md` title and examples, if desired

## 2. Create The Slack App

Start with `docs/SLACK_APP_MANIFEST.yaml`, then replace placeholder URLs and names.

For local development, enable Socket Mode and create an app-level token with `connections:write`. For production, set the interactivity request URL to the CloudFront URL exported by Pulumi.

## 3. Configure Secrets

Local development reads `.env`. Lambda reads AWS Secrets Manager under `SECRET_PREFIX`.

Required Slack secrets:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_APP_TOKEN` for Socket Mode/local dev

Optional Jira secrets:

- `JIRA_BASE_URL`
- `JIRA_USER_EMAIL`
- `JIRA_API_TOKEN`

## 4. Configure Channels

Copy `examples/channel-config.example.js` to `app/src/channel-config.local.js` and add one entry per Slack channel.

Get Slack IDs from the Slack UI:

- Channel ID: channel details -> copy channel ID
- User ID: profile menu -> copy member ID

## 5. Configure Jira

If your Jira workflow requires custom fields such as Team, copy `examples/jira-project-config.example.js` to `app/src/jira-project-config.local.js`.

Use the debug scripts from `app/`:

```bash
node scripts/jira-debug-meta.js PROD
node scripts/jira-debug-create.js PROD Task
node scripts/jira-debug-fields.js --discover-teams PROD
```

## 6. Configure Pulumi

Copy `examples/Pulumi.stack.example.yaml` to `Pulumi.<stack>.yaml` and set values for your stack. Do not commit real stack YAML files if they contain account-specific or secret-adjacent values.

## 7. Deploy

```bash
cd app && npm ci && npm run build
cd ..
uv sync
pulumi preview
pulumi up
```

After deploy, configure your Slack app's production interactivity URL to the exported public URL.
