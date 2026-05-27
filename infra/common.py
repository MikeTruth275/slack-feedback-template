"""Shared infrastructure configuration, constants, and context helpers."""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pulumi
import pulumi_aws as aws

from repo_tags import load_repo_tags, merge_tags

APP_ROOT = Path(__file__).resolve().parent.parent
LAMBDA_SOURCE_DIRECTORY = APP_ROOT / "app" / "dist"
OMNI_DATABASE_READONLY_USERNAME = "omni"
LAMBDA_BASIC_EXECUTION_POLICY_ARN = (
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
)
LAMBDA_VPC_ACCESS_POLICY_ARN = (
    "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
)
VPC_CIDR_BLOCK = "10.42.0.0/16"
PUBLIC_SUBNET_CIDR_BLOCKS = ("10.42.0.0/24", "10.42.1.0/24")
PRIVATE_APP_SUBNET_CIDR_BLOCKS = ("10.42.10.0/24", "10.42.11.0/24")
PRIVATE_DATA_SUBNET_CIDR_BLOCKS = ("10.42.22.0/24", "10.42.21.0/24")
DATABASE_DEFAULT_NAME = "feedback"
DATABASE_DEFAULT_APP_USERNAME = "feedback_app"
DATABASE_DEFAULT_MASTER_USERNAME = "feedback_admin"
DATABASE_DEFAULT_ENGINE_VERSION = "16.6"
DATABASE_PORT = 5432
DATABASE_MIN_CAPACITY = 0.5
DATABASE_MAX_CAPACITY = 2.0
DATABASE_BACKUP_RETENTION_DAYS = 7
DATABASE_FINAL_SNAPSHOT_SUFFIX = "-final-snapshot"
LAMBDA_RESERVED_CONCURRENCY = 5
LOG_RETENTION_DAYS = 90
API_BURST_LIMIT = 100
API_RATE_LIMIT = 50
CLOUDFRONT_PRICE_CLASS = "PriceClass_100"
EDGE_WAF_RATE_LIMIT = 1000
EDGE_ORIGIN_VERIFY_HEADER_NAME = "x-origin-verify"
EDGE_CACHE_POLICY_NAME = "Managed-CachingDisabled"
EDGE_ORIGIN_REQUEST_POLICY_NAME = "Managed-AllViewerExceptHostHeader"
BEDROCK_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"


def normalize_cidr_blocks(config_key: str, cidr_blocks: object) -> list[str]:
    if cidr_blocks is None:
        return []
    if not isinstance(cidr_blocks, list) or not all(
        isinstance(cidr_block, str) for cidr_block in cidr_blocks
    ):
        raise ValueError(f"Set '{config_key}' to a list of CIDR strings.")

    normalized_cidr_blocks: list[str] = []
    for cidr_block in cidr_blocks:
        try:
            normalized_cidr_block = str(ipaddress.ip_network(cidr_block, strict=False))
        except ValueError as error:
            raise ValueError(f"Invalid CIDR in '{config_key}': {cidr_block}") from error
        if normalized_cidr_block not in normalized_cidr_blocks:
            normalized_cidr_blocks.append(normalized_cidr_block)

    return normalized_cidr_blocks


@dataclass(frozen=True)
class InfrastructureContext:
    project: str
    stack: str
    region: str
    base_tags: dict[str, str]
    caller_identity: Any
    primary_availability_zone: str
    secondary_availability_zone: str

    def component_tags(
        self, component: str, extra: dict[str, str] | None = None
    ) -> dict[str, str]:
        return merge_tags(self.base_tags, {"component": component, **(extra or {})})


@dataclass(frozen=True)
class InfrastructureConfig:
    database_cluster_identifier: str
    database_engine_version: str
    database_name: str
    database_app_username: str
    database_master_username: str
    secret_prefix: str
    kms_alias_name: str
    enable_omni_readonly_user: bool
    omni_allowed_cidrs: list[str]
    lambda_reserved_concurrency: int
    alarm_topic_arn: str | None
    alarm_action_arns: list[str] | None
    enable_infisical_secret_sync_role: bool
    infisical_assume_role_principal_arn: str | None
    infisical_external_id: pulumi.Input[str] | None
    infisical_role_name: str


def load_infrastructure_context() -> InfrastructureContext:
    project = pulumi.get_project()
    stack = pulumi.get_stack()
    region = aws.config.region or "us-east-1"
    base_tags = load_repo_tags()
    caller_identity = aws.get_caller_identity_output()
    availability_zones = aws.get_availability_zones(state="available")

    if len(availability_zones.names) < 2:
        raise ValueError("At least two availability zones are required for the application VPC.")

    primary_availability_zone, secondary_availability_zone = availability_zones.names[:2]

    return InfrastructureContext(
        project=project,
        stack=stack,
        region=region,
        base_tags=base_tags,
        caller_identity=caller_identity,
        primary_availability_zone=primary_availability_zone,
        secondary_availability_zone=secondary_availability_zone,
    )


def normalize_secret_prefix(value: str) -> str:
    return value if value.endswith("/") else f"{value}/"


def load_infrastructure_config(context: InfrastructureContext) -> InfrastructureConfig:
    config = pulumi.Config()

    configured_database_cluster_identifier = config.get("databaseClusterIdentifier")
    configured_database_engine_version = config.get("databaseEngineVersion")
    configured_database_name = config.get("databaseName")
    configured_database_user = config.get("databaseUsername")
    configured_database_master_username = config.get("databaseMasterUsername")
    configured_secret_prefix = config.get("secretPrefix")
    configured_kms_alias_name = config.get("kmsAliasName")
    enable_omni_readonly_user = config.get_bool("enableOmniReadonlyUser") or False
    configured_omni_allowed_cidrs = config.get_object("omniAllowedCidrs")
    configured_lambda_reserved_concurrency = config.get_int("lambdaReservedConcurrency")
    alarm_topic_arn = config.get("alarmTopicArn")
    enable_infisical_secret_sync_role = config.get_bool("enableInfisicalSecretSyncRole") or False
    infisical_assume_role_principal_arn = config.get("infisicalAssumeRolePrincipalArn")
    infisical_external_id = config.get_secret("infisicalExternalId")
    infisical_role_name = (
        config.get("infisicalRoleNameOverride") or f"{context.project}-{context.stack}-infisical-sync"
    )

    if enable_infisical_secret_sync_role and not infisical_assume_role_principal_arn:
        raise ValueError(
            "Set 'infisicalAssumeRolePrincipalArn' when 'enableInfisicalSecretSyncRole' is true."
        )

    if enable_infisical_secret_sync_role and infisical_external_id is None:
        raise ValueError(
            "Set secret config 'infisicalExternalId' when 'enableInfisicalSecretSyncRole' is true."
        )

    lambda_reserved_concurrency = (
        configured_lambda_reserved_concurrency
        if configured_lambda_reserved_concurrency is not None
        else LAMBDA_RESERVED_CONCURRENCY
    )

    default_secret_prefix = f"{context.project}/{context.stack}/"

    return InfrastructureConfig(
        database_cluster_identifier=configured_database_cluster_identifier
        or f"{context.project}-{context.stack}",
        database_engine_version=configured_database_engine_version
        or DATABASE_DEFAULT_ENGINE_VERSION,
        database_name=configured_database_name or DATABASE_DEFAULT_NAME,
        database_app_username=configured_database_user or DATABASE_DEFAULT_APP_USERNAME,
        database_master_username=configured_database_master_username
        or DATABASE_DEFAULT_MASTER_USERNAME,
        secret_prefix=normalize_secret_prefix(configured_secret_prefix or default_secret_prefix),
        kms_alias_name=configured_kms_alias_name or f"alias/{context.project}-{context.stack}",
        enable_omni_readonly_user=enable_omni_readonly_user,
        omni_allowed_cidrs=normalize_cidr_blocks(
            "omniAllowedCidrs", configured_omni_allowed_cidrs
        ),
        lambda_reserved_concurrency=lambda_reserved_concurrency,
        alarm_topic_arn=alarm_topic_arn,
        alarm_action_arns=[alarm_topic_arn] if alarm_topic_arn else None,
        enable_infisical_secret_sync_role=enable_infisical_secret_sync_role,
        infisical_assume_role_principal_arn=infisical_assume_role_principal_arn,
        infisical_external_id=infisical_external_id,
        infisical_role_name=infisical_role_name,
    )
