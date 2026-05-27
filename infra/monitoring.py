"""Monitoring and alarms for the feedback infrastructure."""

from __future__ import annotations

import pulumi_aws as aws

from .api import ApiResources
from .common import DATABASE_MAX_CAPACITY, InfrastructureConfig, InfrastructureContext
from .database import DatabaseResources


def create_monitoring_resources(
    context: InfrastructureContext,
    config: InfrastructureConfig,
    api_resources: ApiResources,
    database: DatabaseResources,
) -> None:
    aws.cloudwatch.MetricAlarm(
        "feedback-api-lambda-errors-alarm",
        name=f"{api_resources.lambda_function_name}-errors",
        alarm_description="Alarm when the feedback Lambda reports execution errors",
        namespace="AWS/Lambda",
        metric_name="Errors",
        statistic="Sum",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanThreshold",
        threshold=0,
        dimensions={"FunctionName": api_resources.lambda_function.name},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags(
            "observability", {"Name": f"{api_resources.lambda_function_name}-errors"}
        ),
    )

    aws.cloudwatch.MetricAlarm(
        "feedback-api-lambda-throttles-alarm",
        name=f"{api_resources.lambda_function_name}-throttles",
        alarm_description="Alarm when the feedback Lambda is throttled",
        namespace="AWS/Lambda",
        metric_name="Throttles",
        statistic="Sum",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanThreshold",
        threshold=0,
        dimensions={"FunctionName": api_resources.lambda_function.name},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags(
            "observability", {"Name": f"{api_resources.lambda_function_name}-throttles"}
        ),
    )

    aws.cloudwatch.MetricAlarm(
        "feedback-api-lambda-concurrency-alarm",
        name=f"{api_resources.lambda_function_name}-concurrency",
        alarm_description="Alarm when Lambda concurrency nears the reserved concurrency guardrail",
        namespace="AWS/Lambda",
        metric_name="ConcurrentExecutions",
        statistic="Maximum",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanOrEqualToThreshold",
        threshold=max(1, config.lambda_reserved_concurrency - 1),
        dimensions={"FunctionName": api_resources.lambda_function.name},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags(
            "observability", {"Name": f"{api_resources.lambda_function_name}-concurrency"}
        ),
    )

    aws.cloudwatch.MetricAlarm(
        "feedback-http-api-5xx-alarm",
        name=f"{api_resources.api_name}-5xx",
        alarm_description="Alarm when the public feedback API returns 5xx responses",
        namespace="AWS/ApiGateway",
        metric_name="5xx",
        statistic="Sum",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanThreshold",
        threshold=0,
        dimensions={"ApiId": api_resources.api.id, "Stage": api_resources.api_stage.name},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags("observability", {"Name": f"{api_resources.api_name}-5xx"}),
    )

    aws.cloudwatch.MetricAlarm(
        "feedback-http-api-latency-alarm",
        name=f"{api_resources.api_name}-latency",
        alarm_description="Alarm when public feedback API latency is elevated",
        namespace="AWS/ApiGateway",
        metric_name="Latency",
        extended_statistic="p95",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanThreshold",
        threshold=2000,
        dimensions={"ApiId": api_resources.api.id, "Stage": api_resources.api_stage.name},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags(
            "observability", {"Name": f"{api_resources.api_name}-latency"}
        ),
    )

    aws.cloudwatch.MetricAlarm(
        "feedback-database-connections-alarm",
        name=f"{config.database_cluster_identifier}-connections",
        alarm_description="Alarm when Aurora connection count is elevated for the Lambda guardrail",
        namespace="AWS/RDS",
        metric_name="DatabaseConnections",
        statistic="Maximum",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanThreshold",
        threshold=float(config.lambda_reserved_concurrency + 2),
        dimensions={"DBClusterIdentifier": database.cluster.cluster_identifier},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags(
            "observability", {"Name": f"{config.database_cluster_identifier}-connections"}
        ),
    )

    aws.cloudwatch.MetricAlarm(
        "feedback-database-capacity-alarm",
        name=f"{config.database_cluster_identifier}-capacity",
        alarm_description="Alarm when Aurora Serverless v2 capacity nears the configured maximum",
        namespace="AWS/RDS",
        metric_name="ServerlessDatabaseCapacity",
        statistic="Maximum",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanThreshold",
        threshold=DATABASE_MAX_CAPACITY * 0.9,
        dimensions={"DBClusterIdentifier": database.cluster.cluster_identifier},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags(
            "observability", {"Name": f"{config.database_cluster_identifier}-capacity"}
        ),
    )

    aws.cloudwatch.MetricAlarm(
        "feedback-database-deadlocks-alarm",
        name=f"{config.database_cluster_identifier}-deadlocks",
        alarm_description="Alarm when Aurora PostgreSQL reports deadlocks",
        namespace="AWS/RDS",
        metric_name="Deadlocks",
        statistic="Sum",
        period=300,
        evaluation_periods=1,
        comparison_operator="GreaterThanThreshold",
        threshold=0,
        dimensions={"DBClusterIdentifier": database.cluster.cluster_identifier},
        treat_missing_data="notBreaching",
        alarm_actions=config.alarm_action_arns,
        ok_actions=config.alarm_action_arns,
        tags=context.component_tags(
            "observability", {"Name": f"{config.database_cluster_identifier}-deadlocks"}
        ),
    )
