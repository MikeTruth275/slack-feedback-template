"""Security and secrets infrastructure resources."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pulumi
import pulumi_aws as aws

from .common import InfrastructureConfig, InfrastructureContext


def build_infisical_assume_role_policy(
    principal_arn: str, external_id: pulumi.Input[str]
) -> pulumi.Output[str]:
    return pulumi.Output.from_input(external_id).apply(
        lambda resolved_external_id: json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {"AWS": principal_arn},
                        "Action": "sts:AssumeRole",
                        "Condition": {
                            "StringEquals": {"sts:ExternalId": resolved_external_id}
                        },
                    }
                ],
            }
        )
    )


@dataclass(frozen=True)
class SecurityResources:
    kms_key: aws.kms.Key
    kms_alias: aws.kms.Alias
    secrets_manager_secret_arn_prefix: pulumi.Output[str]
    infisical_sync_role: aws.iam.Role | None


def create_security_resources(
    context: InfrastructureContext, config: InfrastructureConfig
) -> SecurityResources:
    secrets_manager_secret_arn_prefix = pulumi.Output.concat(
        "arn:aws:secretsmanager:",
        context.region,
        ":",
        context.caller_identity.account_id,
        ":secret:",
        config.secret_prefix,
        "*",
    )

    kms_key = aws.kms.Key(
        "application-key",
        description=f"KMS key for {context.project} data and secrets",
        deletion_window_in_days=7,
        enable_key_rotation=True,
        tags=context.component_tags(
            "security",
            {
                "Name": context.project,
                "Purpose": "Application data and secrets encryption",
            },
        ),
    )

    kms_alias = aws.kms.Alias(
        "application-key-alias",
        name=config.kms_alias_name,
        target_key_id=kms_key.key_id,
        opts=pulumi.ResourceOptions(parent=kms_key),
    )

    infisical_sync_role = None
    if config.enable_infisical_secret_sync_role:
        infisical_sync_role = aws.iam.Role(
            "infisical-sync-role",
            name=config.infisical_role_name,
            assume_role_policy=build_infisical_assume_role_policy(
                config.infisical_assume_role_principal_arn,
                config.infisical_external_id,
            ),
            tags=context.component_tags(
                "security",
                {
                    "Name": config.infisical_role_name,
                    "Purpose": "Infisical Secrets Manager Sync",
                },
            ),
        )

        aws.iam.RolePolicy(
            "infisical-sync-policy",
            role=infisical_sync_role.name,
            policy=pulumi.Output.json_dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Sid": "ManageSecretsWithPrefix",
                            "Effect": "Allow",
                            "Action": [
                                "secretsmanager:CreateSecret",
                                "secretsmanager:DeleteSecret",
                                "secretsmanager:DescribeSecret",
                                "secretsmanager:GetSecretValue",
                                "secretsmanager:PutSecretValue",
                                "secretsmanager:TagResource",
                                "secretsmanager:UntagResource",
                                "secretsmanager:UpdateSecret",
                            ],
                            "Resource": [secrets_manager_secret_arn_prefix],
                        },
                        {
                            "Sid": "ListSecrets",
                            "Effect": "Allow",
                            "Action": [
                                "secretsmanager:ListSecrets",
                                "secretsmanager:BatchGetSecretValue",
                            ],
                            "Resource": "*",
                        },
                        {
                            "Sid": "ListKmsAliases",
                            "Effect": "Allow",
                            "Action": ["kms:ListAliases"],
                            "Resource": "*",
                        },
                        {
                            "Sid": "UseApplicationKey",
                            "Effect": "Allow",
                            "Action": [
                                "kms:Decrypt",
                                "kms:DescribeKey",
                                "kms:Encrypt",
                                "kms:GenerateDataKey",
                            ],
                            "Resource": [kms_key.arn],
                        },
                    ],
                }
            ),
            opts=pulumi.ResourceOptions(parent=infisical_sync_role),
        )

    return SecurityResources(
        kms_key=kms_key,
        kms_alias=kms_alias,
        secrets_manager_secret_arn_prefix=secrets_manager_secret_arn_prefix,
        infisical_sync_role=infisical_sync_role,
    )
