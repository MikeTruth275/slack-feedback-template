"""Pulumi program for slack-feedback-template infrastructure."""

import pulumi

from infra.api import create_api_resources
from infra.common import SECRET_PREFIX, load_infrastructure_config, load_infrastructure_context
from infra.database import create_database_resources
from infra.monitoring import create_monitoring_resources
from infra.network import create_network_resources
from infra.security import create_security_resources

context = load_infrastructure_context()
config = load_infrastructure_config(context)

security = create_security_resources(context, config)
network = create_network_resources(context, config)
database = create_database_resources(context, config, network, security)
api = create_api_resources(context, config, network, security, database)

create_monitoring_resources(context, config, api, database)

pulumi.export("database_cluster_identifier", database.cluster.cluster_identifier)
pulumi.export("database_cluster_arn", database.cluster.arn)
pulumi.export("database_cluster_resource_id", database.cluster.cluster_resource_id)
pulumi.export("database_engine_version", database.cluster.engine_version)
pulumi.export("database_endpoint", database.cluster.endpoint)
pulumi.export("database_name", config.database_name)
pulumi.export("database_user", config.database_app_username)
pulumi.export("edge_distribution_domain_name", api.edge_distribution.domain_name)
pulumi.export("kms_key_arn", security.kms_key.arn)
pulumi.export("kms_alias_name", security.kms_alias.name)
pulumi.export("lambda_function_name", api.lambda_function.name)
pulumi.export("lambda_role_name", api.lambda_role.name)
pulumi.export("api_url", api.public_api_url)
pulumi.export("secret_prefix", SECRET_PREFIX)
pulumi.export(
    "infisical_sync_role_arn",
    security.infisical_sync_role.arn if security.infisical_sync_role else None,
)
