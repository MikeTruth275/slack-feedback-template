"""Database infrastructure resources."""

from __future__ import annotations

from dataclasses import dataclass

import pulumi
import pulumi_aws as aws

from db_bootstrap import AuroraBootstrap

from .common import (
    DATABASE_BACKUP_RETENTION_DAYS,
    DATABASE_FINAL_SNAPSHOT_SUFFIX,
    DATABASE_MAX_CAPACITY,
    DATABASE_MIN_CAPACITY,
    DATABASE_PORT,
    LOG_RETENTION_DAYS,
    OMNI_DATABASE_READONLY_USERNAME,
    InfrastructureConfig,
    InfrastructureContext,
)
from .network import NetworkResources
from .security import SecurityResources


def quote_sql_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def quote_sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_final_snapshot_identifier(cluster_identifier: str) -> str:
    sanitized_cluster_identifier = cluster_identifier.replace("_", "-")
    max_prefix_length = 255 - len(DATABASE_FINAL_SNAPSHOT_SUFFIX)
    return (
        f"{sanitized_cluster_identifier[:max_prefix_length]}"
        f"{DATABASE_FINAL_SNAPSHOT_SUFFIX}"
    )


def build_database_bootstrap_statements(
    database_name: str, database_user: str, omni_user: str | None = None
) -> list[str]:
    quoted_database_name = quote_sql_identifier(database_name)
    quoted_database_user = quote_sql_identifier(database_user)
    statements = [
        (
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = "
            f"{quote_sql_literal(database_user)}) THEN CREATE ROLE {quoted_database_user} "
            "LOGIN; END IF; END $$"
        ),
        f"GRANT rds_iam TO {quoted_database_user}",
        f"GRANT CONNECT ON DATABASE {quoted_database_name} TO {quoted_database_user}",
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
        f"GRANT USAGE ON SCHEMA public TO {quoted_database_user}",
        """
        CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL,
            assigned_pm_user_id TEXT,
            status TEXT NOT NULL,
            urgency TEXT NOT NULL,
            thread_ts TEXT,
            payload JSONB NOT NULL,
            -- Auto-derived from payload by Postgres. Read-only; the app never
            -- writes this column. Exists purely so analyst queries (Omni etc.)
            -- can filter on Jira linkage without JSONB-path syntax.
            jira_ticket_key TEXT GENERATED ALWAYS AS (payload->'jiraTicket'->>'key') STORED
        )
        """,
        # Migration for pre-existing clusters created before jira_ticket_key
        # was part of the canonical CREATE TABLE above. No-op on fresh stacks.
        # ADD COLUMN ... STORED rewrites the table once to populate existing
        # rows; at our row count this is sub-second.
        """
        ALTER TABLE feedback
        ADD COLUMN IF NOT EXISTS jira_ticket_key TEXT
        GENERATED ALWAYS AS (payload->'jiraTicket'->>'key') STORED
        """,
        """
        CREATE UNIQUE INDEX IF NOT EXISTS feedback_thread_ts_idx
        ON feedback (thread_ts)
        WHERE thread_ts IS NOT NULL
        """,
        """
        CREATE INDEX IF NOT EXISTS feedback_assigned_pm_status_created_at_idx
        ON feedback (assigned_pm_user_id, status, created_at DESC)
        """,
        """
        CREATE INDEX IF NOT EXISTS feedback_created_at_idx
        ON feedback (created_at DESC)
        """,
        "REVOKE ALL ON TABLE feedback FROM PUBLIC",
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE feedback TO {quoted_database_user}",
        # Slack view_submission idempotency log. The handler does an
        # INSERT ... ON CONFLICT DO NOTHING keyed on view_id to claim the
        # submission; a failed claim means another invocation is already
        # processing it. Solves the "Slack timed out the ack and the user
        # resubmitted" duplicate-post case.
        """
        CREATE TABLE IF NOT EXISTS view_submissions (
            view_id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            feedback_id TEXT
        )
        """,
        # created_at index makes future retention sweeps cheap if/when we
        # add one. No automated retention runs today; rows are ~80 bytes so
        # accumulation isn't a space concern, but we'll want a periodic
        # DELETE WHERE created_at < NOW() - INTERVAL '7 days' once the
        # table has had time to grow.
        """
        CREATE INDEX IF NOT EXISTS view_submissions_created_at_idx
        ON view_submissions (created_at)
        """,
        "REVOKE ALL ON TABLE view_submissions FROM PUBLIC",
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE view_submissions TO {quoted_database_user}",
    ]

    if omni_user:
        quoted_omni_user = quote_sql_identifier(omni_user)
        statements.extend(
            [
                f"GRANT CONNECT ON DATABASE {quoted_database_name} TO {quoted_omni_user}",
                f"GRANT USAGE ON SCHEMA public TO {quoted_omni_user}",
                f"GRANT SELECT ON ALL TABLES IN SCHEMA public TO {quoted_omni_user}",
                f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO {quoted_omni_user}",
            ]
        )

    return statements


def database_master_secret_arn(secrets: list[aws.rds.outputs.ClusterMasterUserSecret]) -> str:
    if not secrets:
        raise ValueError("Aurora cluster did not return a managed master user secret.")
    return secrets[0].secret_arn


@dataclass(frozen=True)
class DatabaseResources:
    cluster: aws.rds.Cluster
    writer: aws.rds.ClusterInstance
    bootstrap: AuroraBootstrap
    connect_resource_arn: pulumi.Output[str]


def create_database_resources(
    context: InfrastructureContext,
    config: InfrastructureConfig,
    network: NetworkResources,
    security: SecurityResources,
) -> DatabaseResources:
    database_subnet_group = aws.rds.SubnetGroup(
        "feedback-database-subnet-group",
        name=f"{config.database_cluster_identifier}-subnets",
        subnet_ids=[subnet.id for subnet in network.private_data_subnets],
        description="Private subnet group for Aurora PostgreSQL",
        tags=context.component_tags(
            "database",
            {
                "Name": f"{config.database_cluster_identifier}-subnets",
                "Purpose": "Aurora PostgreSQL subnet placement",
            },
        ),
    )

    database_log_groups = [
        aws.cloudwatch.LogGroup(
            "feedback-database-postgresql-log-group",
            name=f"/aws/rds/cluster/{config.database_cluster_identifier}/postgresql",
            retention_in_days=LOG_RETENTION_DAYS,
            tags=context.component_tags(
                "observability",
                {
                    "Name": f"{config.database_cluster_identifier}-postgresql-logs",
                    "Purpose": "Aurora PostgreSQL engine logs",
                },
            ),
        ),
        aws.cloudwatch.LogGroup(
            "feedback-database-iam-auth-log-group",
            name=f"/aws/rds/cluster/{config.database_cluster_identifier}/iam-db-auth-error",
            retention_in_days=LOG_RETENTION_DAYS,
            tags=context.component_tags(
                "observability",
                {
                    "Name": f"{config.database_cluster_identifier}-iam-auth-logs",
                    "Purpose": "Aurora IAM database authentication error logs",
                },
            ),
        ),
    ]

    database_cluster = aws.rds.Cluster(
        "feedback-database-cluster",
        cluster_identifier=config.database_cluster_identifier,
        engine="aurora-postgresql",
        engine_mode="provisioned",
        engine_version=config.database_engine_version,
        database_name=config.database_name,
        master_username=config.database_master_username,
        manage_master_user_password=True,
        master_user_secret_kms_key_id=security.kms_key.arn,
        db_subnet_group_name=database_subnet_group.name,
        vpc_security_group_ids=[network.database_security_group.id],
        port=DATABASE_PORT,
        storage_encrypted=True,
        kms_key_id=security.kms_key.arn,
        backup_retention_period=DATABASE_BACKUP_RETENTION_DAYS,
        copy_tags_to_snapshot=True,
        deletion_protection=True,
        enable_http_endpoint=True,
        enabled_cloudwatch_logs_exports=["postgresql", "iam-db-auth-error"],
        final_snapshot_identifier=build_final_snapshot_identifier(
            config.database_cluster_identifier
        ),
        iam_database_authentication_enabled=True,
        serverlessv2_scaling_configuration={
            "min_capacity": DATABASE_MIN_CAPACITY,
            "max_capacity": DATABASE_MAX_CAPACITY,
        },
        skip_final_snapshot=False,
        tags=context.component_tags(
            "database",
            {
                "Name": config.database_cluster_identifier,
                "Purpose": "Aurora PostgreSQL feedback storage",
            },
        ),
        opts=pulumi.ResourceOptions(depends_on=[security.kms_alias, *database_log_groups]),
    )

    database_writer = aws.rds.ClusterInstance(
        "feedback-database-writer",
        identifier=f"{config.database_cluster_identifier}-writer",
        cluster_identifier=database_cluster.id,
        engine=database_cluster.engine,
        engine_version=database_cluster.engine_version,
        instance_class="db.serverless",
        db_subnet_group_name=database_subnet_group.name,
        publicly_accessible=True,
        tags=context.component_tags(
            "database",
            {
                "Name": f"{config.database_cluster_identifier}-writer",
                "Purpose": "Aurora PostgreSQL primary writer",
            },
        ),
        opts=pulumi.ResourceOptions(parent=database_cluster),
    )

    database_master_secret_arn_output = database_cluster.master_user_secrets.apply(
        database_master_secret_arn
    )
    database_bootstrap_statements = pulumi.Output.all(
        config.database_name, config.database_app_username, config.enable_omni_readonly_user
    ).apply(
        lambda args: build_database_bootstrap_statements(
            database_name=args[0],
            database_user=args[1],
            omni_user=OMNI_DATABASE_READONLY_USERNAME if args[2] else None,
        )
    )

    database_bootstrap = AuroraBootstrap(
        "feedback-database-bootstrap",
        cluster_arn=database_cluster.arn,
        secret_arn=database_master_secret_arn_output,
        database_name=config.database_name,
        region=context.region,
        statements=database_bootstrap_statements,
        omni_username=OMNI_DATABASE_READONLY_USERNAME if config.enable_omni_readonly_user else None,
        omni_password_secret_id=(
            f"{config.secret_prefix}OMNI_DB_USER_PASSWORD"
            if config.enable_omni_readonly_user
            else None
        ),
        opts=pulumi.ResourceOptions(depends_on=[database_writer]),
    )

    database_connect_resource_arn = pulumi.Output.concat(
        "arn:aws:rds-db:",
        context.region,
        ":",
        context.caller_identity.account_id,
        ":dbuser:",
        database_cluster.cluster_resource_id,
        "/",
        config.database_app_username,
    )

    return DatabaseResources(
        cluster=database_cluster,
        writer=database_writer,
        bootstrap=database_bootstrap,
        connect_resource_arn=database_connect_resource_arn,
    )
