# Configuration Reference

## App Environment Variables

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | none | Slack bot token for local mode or Secrets Manager value |
| `SLACK_SIGNING_SECRET` | yes | none | Slack request signing secret |
| `SLACK_APP_TOKEN` | local only | none | Socket Mode app token |
| `SLACK_FEEDBACK_COMMAND` | no | `/logfeedback` | Slash command registered in Slack |
| `SLACK_BOT_DISPLAY_NAME` | no | `Product Feedback Bot` | Name used in instructional messages |
| `SLACK_APP_DISPLAY_NAME` | no | `Product Feedback Bot` | Name used in App Home UI |
| `BUG_REPORT_CHANNEL_ID` | no | unset | Slack channel ID shown in the feedback modal bug notice |
| `ACCOUNTS_CSV_PATH` | no | `app/src/accounts.csv` then example CSV | Private account list path |
| `JIRA_BASE_URL` | no | none | Jira Cloud base URL |
| `JIRA_USER_EMAIL` | no | none | Jira service account email |
| `JIRA_API_TOKEN` | no | none | Jira API token |
| `JIRA_LABEL_PREFIX` | no | `slack-feedback` | Label prefix for created tickets and duplicate search |
| `JIRA_TEAM_FIELD_ID` | no | unset | Default Jira Teams custom field ID |
| `COMPANY_NAME` | no | `your company` | Company name used in Bedrock routing prompts |
| `DUPLICATE_DETECTION_ENABLED` | no | `true` | Enables Jira plus Bedrock duplicate suggestions |
| `ROUTING_NUDGE_ENABLED` | no | `true` | Enables Bedrock routing suggestions |
| `ROUTING_CONFIDENCE_THRESHOLD` | no | `0.75` | Minimum routing confidence for a nudge |
| `BEDROCK_MODEL_ID` | no | Claude 3 Haiku model ID | Bedrock model used by the app |
| `BEDROCK_REGION` | no | `AWS_REGION` | Bedrock region override |
| `BEDROCK_TIMEOUT_MS` | no | `4000` | Bedrock call timeout |
| `SECRET_PREFIX` | Lambda | Pulumi-configured | Secrets Manager prefix |
| `BACKGROUND_LAMBDA_FUNCTION_NAME` | Lambda | current function | Async self-invoke target |

## Pulumi Config Keys

| Key | Default | Purpose |
| --- | --- | --- |
| `secretPrefix` | `<project>/<stack>/` | Secrets Manager prefix for app secrets |
| `kmsAliasName` | `alias/<project>-<stack>` | KMS alias for app data and secrets |
| `databaseClusterIdentifier` | `<project>-<stack>` | Aurora cluster identifier |
| `databaseEngineVersion` | `16.6` | Aurora PostgreSQL engine version |
| `databaseName` | `feedback` | Database name |
| `databaseUsername` | `feedback_app` | IAM-authenticated app database user |
| `databaseMasterUsername` | `feedback_admin` | Aurora master username |
| `lambdaReservedConcurrency` | `5` | Lambda concurrency cap |
| `alarmTopicArn` | unset | Optional SNS topic for alarms |
| `enableInfisicalSecretSyncRole` | `false` | Creates an optional secret-sync IAM role |
| `infisicalAssumeRolePrincipalArn` | unset | Principal ARN for optional secret sync |
| `infisicalExternalId` | unset | Secret external ID for optional secret sync |
| `enableOmniReadonlyUser` | `false` | Creates optional readonly database user grants |
| `omniAllowedCidrs` | empty | Optional readonly database ingress CIDRs |
