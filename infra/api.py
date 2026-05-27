"""Application, API, and edge infrastructure resources."""

from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import urlparse

import pulumi
import pulumi_aws as aws
import pulumi_random as random

from .common import (
    API_BURST_LIMIT,
    API_RATE_LIMIT,
    BEDROCK_MODEL_ID,
    CLOUDFRONT_PRICE_CLASS,
    DATABASE_PORT,
    EDGE_CACHE_POLICY_NAME,
    EDGE_ORIGIN_REQUEST_POLICY_NAME,
    EDGE_ORIGIN_VERIFY_HEADER_NAME,
    EDGE_WAF_RATE_LIMIT,
    LAMBDA_BASIC_EXECUTION_POLICY_ARN,
    LAMBDA_SOURCE_DIRECTORY,
    LAMBDA_VPC_ACCESS_POLICY_ARN,
    LOG_RETENTION_DAYS,
    InfrastructureConfig,
    InfrastructureContext,
)
from .database import DatabaseResources
from .network import NetworkResources
from .security import SecurityResources


def extract_domain_name(url: str) -> str:
    return urlparse(url).netloc


@dataclass(frozen=True)
class ApiResources:
    lambda_role: aws.iam.Role
    lambda_function: aws.lambda_.Function
    api: aws.apigatewayv2.Api
    api_stage: aws.apigatewayv2.Stage
    edge_distribution: aws.cloudfront.Distribution
    public_api_url: pulumi.Output[str]
    lambda_function_name: str
    api_name: str


def create_api_resources(
    context: InfrastructureContext,
    config: InfrastructureConfig,
    network: NetworkResources,
    security: SecurityResources,
    database: DatabaseResources,
) -> ApiResources:
    lambda_role_name = f"{context.project}-{context.stack}-lambda"
    lambda_role = aws.iam.Role(
        "feedback-api-lambda-role",
        name=lambda_role_name,
        assume_role_policy=pulumi.Output.json_dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {"Service": "lambda.amazonaws.com"},
                        "Action": "sts:AssumeRole",
                    }
                ],
            }
        ),
        tags=context.component_tags(
            "compute",
            {
                "Name": lambda_role_name,
                "Purpose": "Slack product feedback Lambda execution",
            },
        ),
    )

    lambda_basic_execution_attachment = aws.iam.RolePolicyAttachment(
        "feedback-api-lambda-basic-execution",
        role=lambda_role.name,
        policy_arn=LAMBDA_BASIC_EXECUTION_POLICY_ARN,
        opts=pulumi.ResourceOptions(parent=lambda_role),
    )

    lambda_vpc_access_attachment = aws.iam.RolePolicyAttachment(
        "feedback-api-lambda-vpc-access",
        role=lambda_role.name,
        policy_arn=LAMBDA_VPC_ACCESS_POLICY_ARN,
        opts=pulumi.ResourceOptions(parent=lambda_role),
    )

    lambda_function_name = f"{context.project}-{context.stack}-api"
    # Lambda's own ARN, computed up front so the role can grant self-invoke
    # without a circular dependency on the function resource. Used by the
    # handler to push the post-submit Bedrock work (duplicate detection +
    # routing nudge) onto a separate async invocation so the modal ack stays
    # under Slack's 3s view_submission window.
    lambda_self_arn = pulumi.Output.all(
        region=context.region,
        account_id=context.caller_identity.account_id,
    ).apply(
        lambda args: f"arn:aws:lambda:{args['region']}:{args['account_id']}:function:{lambda_function_name}"
    )

    lambda_access_policy = aws.iam.RolePolicy(
        "feedback-api-lambda-access",
        role=lambda_role.name,
        policy=pulumi.Output.json_dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Sid": "ConnectToFeedbackDatabase",
                        "Effect": "Allow",
                        "Action": ["rds-db:connect"],
                        "Resource": [database.connect_resource_arn],
                    },
                    {
                        "Sid": "ReadApplicationSecrets",
                        "Effect": "Allow",
                        "Action": [
                            "secretsmanager:DescribeSecret",
                            "secretsmanager:GetSecretValue",
                        ],
                        "Resource": [security.secrets_manager_secret_arn_prefix],
                    },
                    {
                        "Sid": "UseApplicationKey",
                        "Effect": "Allow",
                        "Action": ["kms:Decrypt", "kms:DescribeKey"],
                        "Resource": [security.kms_key.arn],
                    },
                    {
                        # Bedrock foundation model invocations for the
                        # duplicate-detection rerank. Scoped to the single
                        # Haiku model in the Lambda's region; the model ARN
                        # for foundation models has an empty account segment.
                        "Sid": "InvokeBedrockRerankModel",
                        "Effect": "Allow",
                        "Action": ["bedrock:InvokeModel"],
                        "Resource": [
                            f"arn:aws:bedrock:{context.region}::foundation-model/{BEDROCK_MODEL_ID}"
                        ],
                    },
                    {
                        # Async self-invoke for post-submit background work.
                        # Slack's view_submission ack deadline is 3s; Bedrock
                        # duplicate-detection + routing classification can
                        # take up to ~8s combined, so the foreground handler
                        # fires-and-forgets a second invocation of itself
                        # (InvocationType=Event) and returns immediately.
                        "Sid": "AsyncSelfInvokeForBackgroundWork",
                        "Effect": "Allow",
                        "Action": ["lambda:InvokeFunction"],
                        "Resource": [lambda_self_arn],
                    },
                ],
            }
        ),
        opts=pulumi.ResourceOptions(parent=lambda_role),
    )
    lambda_log_group = aws.cloudwatch.LogGroup(
        "feedback-api-lambda-log-group",
        name=f"/aws/lambda/{lambda_function_name}",
        retention_in_days=LOG_RETENTION_DAYS,
        tags=context.component_tags(
            "observability",
            {
                "Name": f"{lambda_function_name}-logs",
                "Purpose": "Retained Lambda execution logs",
            },
        ),
    )

    edge_origin_verify_secret = random.RandomPassword(
        "feedback-edge-origin-verify-secret",
        length=32,
        special=False,
        upper=True,
        lower=True,
        numeric=True,
        opts=pulumi.ResourceOptions(additional_secret_outputs=["result"]),
    )

    lambda_function = aws.lambda_.Function(
        "feedback-api-lambda",
        name=lambda_function_name,
        role=lambda_role.arn,
        runtime=aws.lambda_.Runtime.NODE_JS22D_X,
        handler="app.handler",
        code=pulumi.FileArchive(str(LAMBDA_SOURCE_DIRECTORY)),
        description="Slack product feedback HTTP API handler",
        memory_size=256,
        timeout=30,
        environment={
            "variables": {
                "DB_HOST": database.cluster.endpoint,
                "DB_NAME": config.database_name,
                "DB_PORT": str(DATABASE_PORT),
                "DB_USER": config.database_app_username,
                "EDGE_ORIGIN_VERIFY_HEADER_NAME": EDGE_ORIGIN_VERIFY_HEADER_NAME,
                "EDGE_ORIGIN_VERIFY_SECRET": edge_origin_verify_secret.result,
                "SECRET_PREFIX": config.secret_prefix,
                "BEDROCK_MODEL_ID": BEDROCK_MODEL_ID,
                "DUPLICATE_DETECTION_ENABLED": "true",
                # Used by the handler to async self-invoke for post-submit
                # background work (duplicate detection + routing nudge) so
                # the foreground handler can return inside Slack's 3s ack
                # window. AWS_LAMBDA_FUNCTION_NAME is set by the runtime,
                # but pinning it explicitly keeps the indirection auditable.
                "BACKGROUND_LAMBDA_FUNCTION_NAME": lambda_function_name,
            }
        },
        reserved_concurrent_executions=config.lambda_reserved_concurrency,
        vpc_config={
            "security_group_ids": [network.lambda_security_group.id],
            "subnet_ids": [subnet.id for subnet in network.private_app_subnets],
        },
        tags=context.component_tags("compute", {"Name": lambda_function_name}),
        opts=pulumi.ResourceOptions(
            depends_on=[
                lambda_basic_execution_attachment,
                lambda_vpc_access_attachment,
                lambda_access_policy,
                lambda_log_group,
                database.bootstrap,
            ]
        ),
    )

    api_name = f"{context.project}-{context.stack}-api"
    api = aws.apigatewayv2.Api(
        "feedback-http-api",
        name=api_name,
        protocol_type="HTTP",
        tags=context.component_tags("api", {"Name": api_name}),
    )

    integration = aws.apigatewayv2.Integration(
        "feedback-http-api-integration",
        api_id=api.id,
        integration_type="AWS_PROXY",
        integration_uri=lambda_function.arn,
        payload_format_version="2.0",
        opts=pulumi.ResourceOptions(parent=api),
    )

    integration_target = integration.id.apply(
        lambda integration_id: f"integrations/{integration_id}"
    )

    api_root_route = aws.apigatewayv2.Route(
        "feedback-http-api-root-route",
        api_id=api.id,
        route_key="POST /",
        target=integration_target,
        opts=pulumi.ResourceOptions(parent=api),
    )

    api_access_log_group = aws.cloudwatch.LogGroup(
        "feedback-http-api-access-log-group",
        name=f"/aws/apigateway/{api_name}",
        retention_in_days=LOG_RETENTION_DAYS,
        tags=context.component_tags(
            "observability",
            {
                "Name": f"{api_name}-access-logs",
                "Purpose": "Retained API Gateway access logs",
            },
        ),
    )

    api_stage = aws.apigatewayv2.Stage(
        "feedback-http-api-stage",
        api_id=api.id,
        name="$default",
        auto_deploy=True,
        access_log_settings={
            "destination_arn": api_access_log_group.arn,
            "format": json.dumps(
                {
                    "requestId": "$context.requestId",
                    "ip": "$context.identity.sourceIp",
                    "requestTime": "$context.requestTime",
                    "httpMethod": "$context.httpMethod",
                    "routeKey": "$context.routeKey",
                    "status": "$context.status",
                    "protocol": "$context.protocol",
                    "path": "$context.path",
                    "responseLength": "$context.responseLength",
                    "integrationErrorMessage": "$context.integrationErrorMessage",
                    "errorMessage": "$context.error.message",
                }
            ),
        },
        default_route_settings={
            "detailed_metrics_enabled": True,
            "throttling_burst_limit": API_BURST_LIMIT,
            "throttling_rate_limit": API_RATE_LIMIT,
        },
        tags=context.component_tags("api"),
        opts=pulumi.ResourceOptions(parent=api, depends_on=[api_root_route, api_access_log_group]),
    )

    edge_cache_policy = aws.cloudfront.get_cache_policy_output(name=EDGE_CACHE_POLICY_NAME)
    edge_origin_request_policy = aws.cloudfront.get_origin_request_policy_output(
        name=EDGE_ORIGIN_REQUEST_POLICY_NAME
    )

    edge_web_acl = aws.wafv2.WebAcl(
        "feedback-edge-web-acl",
        name=f"{api_name}-edge-waf",
        scope="CLOUDFRONT",
        description="WAF for the Slack feedback CloudFront edge",
        association_config={
            "request_bodies": [
                {
                    "cloudfront": {
                        "default_size_inspection_limit": "KB_64",
                    }
                }
            ]
        },
        default_action={"allow": {}},
        visibility_config={
            "cloudwatch_metrics_enabled": True,
            "metric_name": "feedbackEdgeWaf",
            "sampled_requests_enabled": True,
        },
        rules=[
            {
                "name": "AWSManagedRulesCommonRuleSet",
                "priority": 0,
                "override_action": {"none": {}},
                "statement": {
                    "managed_rule_group_statement": {
                        "name": "AWSManagedRulesCommonRuleSet",
                        "vendor_name": "AWS",
                        "rule_action_overrides": [
                            {
                                "name": "SizeRestrictions_BODY",
                                "action_to_use": {"count": {}},
                            }
                        ],
                    }
                },
                "visibility_config": {
                    "cloudwatch_metrics_enabled": True,
                    "metric_name": "feedbackEdgeCommonRules",
                    "sampled_requests_enabled": True,
                },
            },
            {
                "name": "AWSManagedRulesKnownBadInputsRuleSet",
                "priority": 1,
                "override_action": {"none": {}},
                "statement": {
                    "managed_rule_group_statement": {
                        "name": "AWSManagedRulesKnownBadInputsRuleSet",
                        "vendor_name": "AWS",
                    }
                },
                "visibility_config": {
                    "cloudwatch_metrics_enabled": True,
                    "metric_name": "feedbackEdgeKnownBadInputs",
                    "sampled_requests_enabled": True,
                },
            },
            {
                "name": "AWSManagedRulesAmazonIpReputationList",
                "priority": 2,
                "override_action": {"none": {}},
                "statement": {
                    "managed_rule_group_statement": {
                        "name": "AWSManagedRulesAmazonIpReputationList",
                        "vendor_name": "AWS",
                    }
                },
                "visibility_config": {
                    "cloudwatch_metrics_enabled": True,
                    "metric_name": "feedbackEdgeIpReputation",
                    "sampled_requests_enabled": True,
                },
            },
            {
                "name": "RateLimitPerIp",
                "priority": 3,
                "action": {"block": {}},
                "statement": {
                    "rate_based_statement": {
                        "aggregate_key_type": "IP",
                        "limit": EDGE_WAF_RATE_LIMIT,
                    }
                },
                "visibility_config": {
                    "cloudwatch_metrics_enabled": True,
                    "metric_name": "feedbackEdgeRateLimit",
                    "sampled_requests_enabled": True,
                },
            },
        ],
        tags=context.component_tags(
            "security",
            {
                "Name": f"{api_name}-edge-waf",
                "Purpose": "Protect the public Slack API edge with managed rules and rate limiting",
            },
        ),
    )

    edge_distribution = aws.cloudfront.Distribution(
        "feedback-edge-distribution",
        enabled=True,
        is_ipv6_enabled=True,
        price_class=CLOUDFRONT_PRICE_CLASS,
        web_acl_id=edge_web_acl.arn,
        wait_for_deployment=True,
        origins=[
            {
                "domain_name": api.api_endpoint.apply(extract_domain_name),
                "origin_id": "feedback-http-api-origin",
                "custom_headers": [
                    {
                        "name": EDGE_ORIGIN_VERIFY_HEADER_NAME,
                        "value": edge_origin_verify_secret.result,
                    }
                ],
                "custom_origin_config": {
                    "http_port": 80,
                    "https_port": 443,
                    "origin_protocol_policy": "https-only",
                    "origin_ssl_protocols": ["TLSv1.2"],
                    "origin_read_timeout": 30,
                    "origin_keepalive_timeout": 5,
                },
            }
        ],
        default_cache_behavior={
            "allowed_methods": [
                "HEAD",
                "DELETE",
                "POST",
                "GET",
                "OPTIONS",
                "PUT",
                "PATCH",
            ],
            "cached_methods": ["GET", "HEAD", "OPTIONS"],
            "cache_policy_id": edge_cache_policy.id,
            "compress": False,
            "origin_request_policy_id": edge_origin_request_policy.id,
            "target_origin_id": "feedback-http-api-origin",
            "viewer_protocol_policy": "redirect-to-https",
        },
        restrictions={"geo_restriction": {"restriction_type": "none"}},
        viewer_certificate={"cloudfront_default_certificate": True},
        tags=context.component_tags(
            "edge",
            {
                "Name": f"{api_name}-edge",
                "Purpose": "CloudFront edge for HTTP API protection and WAF enforcement",
            },
        ),
        opts=pulumi.ResourceOptions(depends_on=[api_stage, edge_web_acl]),
    )

    public_api_url = pulumi.Output.concat("https://", edge_distribution.domain_name)

    aws.lambda_.Permission(
        "feedback-http-api-invoke-permission",
        action="lambda:InvokeFunction",
        function=lambda_function.name,
        principal="apigateway.amazonaws.com",
        source_arn=api.execution_arn.apply(lambda arn: f"{arn}/*"),
        opts=pulumi.ResourceOptions(parent=lambda_function, depends_on=[api_stage]),
    )

    return ApiResources(
        lambda_role=lambda_role,
        lambda_function=lambda_function,
        api=api,
        api_stage=api_stage,
        edge_distribution=edge_distribution,
        public_api_url=public_api_url,
        lambda_function_name=lambda_function_name,
        api_name=api_name,
    )
