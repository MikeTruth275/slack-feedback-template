# AGENTS.md

Guidance for coding agents working on this template.

## Repo at a glance

- `app/` is the Slack Bolt.js app. Entry point: `app/src/app.js`.
- `infra/` is Pulumi Python infrastructure for Lambda, Aurora, CloudFront, WAF, IAM, and monitoring.
- `db_bootstrap.py` applies Aurora DDL/grants through the RDS Data API.
- `examples/` contains public-safe starter config. Real tenant config belongs in gitignored local files.

## Important constraints

- Do not commit real Slack channel IDs, Slack user IDs, customer names, Jira team UUIDs, AWS account IDs, or secrets.
- Keep Slack interaction handlers fast. With `AwsLambdaReceiver`, Slack's 3-second ack window includes the full Lambda handler duration. Heavy work belongs in the background self-invoke path.
- If adding dependencies, add Node dependencies under `app/` and Python dependencies in `pyproject.toml`.

## Useful checks

- App build: `cd app && npm ci && npm run build`
- Infra deps: `uv sync`
- Sanitization scan before publishing: search for company names, internal org names, account IDs, real Slack IDs, real Jira UUIDs, and customer data.
