"""Networking infrastructure resources."""

from __future__ import annotations

from dataclasses import dataclass

import pulumi
import pulumi_aws as aws

from .common import (
    DATABASE_PORT,
    PRIVATE_APP_SUBNET_CIDR_BLOCKS,
    PRIVATE_DATA_SUBNET_CIDR_BLOCKS,
    PUBLIC_SUBNET_CIDR_BLOCKS,
    VPC_CIDR_BLOCK,
    InfrastructureConfig,
    InfrastructureContext,
)


@dataclass(frozen=True)
class NetworkResources:
    vpc: aws.ec2.Vpc
    public_subnets: list[aws.ec2.Subnet]
    private_app_subnets: list[aws.ec2.Subnet]
    private_data_subnets: list[aws.ec2.Subnet]
    lambda_security_group: aws.ec2.SecurityGroup
    database_security_group: aws.ec2.SecurityGroup


def create_network_resources(
    context: InfrastructureContext, config: InfrastructureConfig
) -> NetworkResources:
    vpc_name = f"{context.project}-{context.stack}"
    vpc = aws.ec2.Vpc(
        "feedback-vpc",
        cidr_block=VPC_CIDR_BLOCK,
        enable_dns_hostnames=True,
        enable_dns_support=True,
        tags=context.component_tags(
            "network",
            {
                "Name": vpc_name,
                "Purpose": "Application VPC for private compute and data services",
            },
        ),
    )

    internet_gateway = aws.ec2.InternetGateway(
        "feedback-vpc-internet-gateway",
        vpc_id=vpc.id,
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-igw",
                "Purpose": "Internet gateway for managed egress through NAT",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    public_subnets: list[aws.ec2.Subnet] = []
    private_app_subnets: list[aws.ec2.Subnet] = []
    private_data_subnets: list[aws.ec2.Subnet] = []

    for (
        suffix,
        availability_zone,
        public_cidr_block,
        private_app_cidr_block,
        private_data_cidr_block,
    ) in zip(
        ("a", "b"),
        (context.primary_availability_zone, context.secondary_availability_zone),
        PUBLIC_SUBNET_CIDR_BLOCKS,
        PRIVATE_APP_SUBNET_CIDR_BLOCKS,
        PRIVATE_DATA_SUBNET_CIDR_BLOCKS,
        strict=True,
    ):
        public_subnets.append(
            aws.ec2.Subnet(
                f"feedback-public-subnet-{suffix}",
                vpc_id=vpc.id,
                cidr_block=public_cidr_block,
                availability_zone=availability_zone,
                map_public_ip_on_launch=True,
                tags=context.component_tags(
                    "network",
                    {
                        "Name": f"{vpc_name}-public-{suffix}",
                        "Purpose": "Public subnet for NAT and internet gateway routing",
                    },
                ),
                opts=pulumi.ResourceOptions(parent=vpc),
            )
        )

        private_app_subnets.append(
            aws.ec2.Subnet(
                f"feedback-private-app-subnet-{suffix}",
                vpc_id=vpc.id,
                cidr_block=private_app_cidr_block,
                availability_zone=availability_zone,
                map_public_ip_on_launch=False,
                tags=context.component_tags(
                    "network",
                    {
                        "Name": f"{vpc_name}-private-app-{suffix}",
                        "Purpose": "Private application subnet for Lambda execution",
                    },
                ),
                opts=pulumi.ResourceOptions(parent=vpc),
            )
        )

        private_data_subnets.append(
            aws.ec2.Subnet(
                f"feedback-private-data-subnet-{suffix}",
                vpc_id=vpc.id,
                cidr_block=private_data_cidr_block,
                availability_zone=availability_zone,
                map_public_ip_on_launch=False,
                tags=context.component_tags(
                    "network",
                    {
                        "Name": f"{vpc_name}-private-data-{suffix}",
                        "Purpose": "Isolated private subnet for Aurora PostgreSQL",
                    },
                ),
                opts=pulumi.ResourceOptions(parent=vpc),
            )
        )

    public_route_table = aws.ec2.RouteTable(
        "feedback-public-route-table",
        vpc_id=vpc.id,
        routes=[{"cidr_block": "0.0.0.0/0", "gateway_id": internet_gateway.id}],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-public-rt",
                "Purpose": "Public routing for NAT gateway",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    for suffix, subnet in zip(("a", "b"), public_subnets, strict=True):
        aws.ec2.RouteTableAssociation(
            f"feedback-public-route-table-association-{suffix}",
            subnet_id=subnet.id,
            route_table_id=public_route_table.id,
            opts=pulumi.ResourceOptions(parent=public_route_table),
        )

    nat_gateway_eip = aws.ec2.Eip(
        "feedback-nat-gateway-eip",
        domain="vpc",
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-nat-eip",
                "Purpose": "Elastic IP for NAT gateway",
            },
        ),
    )

    nat_gateway = aws.ec2.NatGateway(
        "feedback-nat-gateway",
        allocation_id=nat_gateway_eip.id,
        subnet_id=public_subnets[0].id,
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-nat",
                "Purpose": "Managed egress for private application subnets",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc, depends_on=[public_route_table]),
    )

    private_app_route_table = aws.ec2.RouteTable(
        "feedback-private-app-route-table",
        vpc_id=vpc.id,
        routes=[{"cidr_block": "0.0.0.0/0", "nat_gateway_id": nat_gateway.id}],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-private-app-rt",
                "Purpose": "Private routing for Lambda egress",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    for suffix, subnet in zip(("a", "b"), private_app_subnets, strict=True):
        aws.ec2.RouteTableAssociation(
            f"feedback-private-app-route-table-association-{suffix}",
            subnet_id=subnet.id,
            route_table_id=private_app_route_table.id,
            opts=pulumi.ResourceOptions(parent=private_app_route_table),
        )

    private_data_route_table = aws.ec2.RouteTable(
        "feedback-private-data-route-table",
        vpc_id=vpc.id,
        routes=[{"cidr_block": "0.0.0.0/0", "gateway_id": internet_gateway.id}],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-private-data-rt",
                "Purpose": "Internet-routable Aurora subnets restricted by security groups",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    for suffix, subnet in zip(("a", "b"), private_data_subnets, strict=True):
        aws.ec2.RouteTableAssociation(
            f"feedback-private-data-route-table-association-{suffix}",
            subnet_id=subnet.id,
            route_table_id=private_data_route_table.id,
            opts=pulumi.ResourceOptions(parent=private_data_route_table),
        )

    lambda_security_group = aws.ec2.SecurityGroup(
        "feedback-lambda-security-group",
        vpc_id=vpc.id,
        description="Security group for the Slack feedback Lambda function",
        egress=[
            {
                "protocol": "-1",
                "from_port": 0,
                "to_port": 0,
                "cidr_blocks": ["0.0.0.0/0"],
            }
        ],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-lambda-sg",
                "Purpose": "Network controls for Lambda execution",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    database_security_group = aws.ec2.SecurityGroup(
        "feedback-database-security-group",
        vpc_id=vpc.id,
        description="Allow Lambda access to the private Aurora PostgreSQL cluster",
        ingress=[
            {
                "protocol": "tcp",
                "from_port": DATABASE_PORT,
                "to_port": DATABASE_PORT,
                "security_groups": [lambda_security_group.id],
            },
            *(
                [
                    {
                        "protocol": "tcp",
                        "from_port": DATABASE_PORT,
                        "to_port": DATABASE_PORT,
                        "cidr_blocks": config.omni_allowed_cidrs,
                    }
                ]
                if config.omni_allowed_cidrs
                else []
            ),
        ],
        egress=[
            {
                "protocol": "-1",
                "from_port": 0,
                "to_port": 0,
                "cidr_blocks": ["0.0.0.0/0"],
            }
        ],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-database-sg",
                "Purpose": "Restrict Aurora access to Lambda and configured Omni CIDRs",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    vpc_endpoint_security_group = aws.ec2.SecurityGroup(
        "feedback-vpc-endpoint-security-group",
        vpc_id=vpc.id,
        description="Allow Lambda access to private AWS service endpoints",
        ingress=[
            {
                "protocol": "tcp",
                "from_port": 443,
                "to_port": 443,
                "security_groups": [lambda_security_group.id],
            }
        ],
        egress=[
            {
                "protocol": "-1",
                "from_port": 0,
                "to_port": 0,
                "cidr_blocks": ["0.0.0.0/0"],
            }
        ],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-vpce-sg",
                "Purpose": "Protect interface VPC endpoints",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    interface_vpc_endpoint_subnet_ids = [subnet.id for subnet in private_app_subnets]

    aws.ec2.VpcEndpoint(
        "feedback-secrets-manager-vpc-endpoint",
        vpc_id=vpc.id,
        service_name=f"com.amazonaws.{context.region}.secretsmanager",
        vpc_endpoint_type="Interface",
        private_dns_enabled=True,
        subnet_ids=interface_vpc_endpoint_subnet_ids,
        security_group_ids=[vpc_endpoint_security_group.id],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-secretsmanager-vpce",
                "Purpose": "Private Secrets Manager access from Lambda",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    aws.ec2.VpcEndpoint(
        "feedback-kms-vpc-endpoint",
        vpc_id=vpc.id,
        service_name=f"com.amazonaws.{context.region}.kms",
        vpc_endpoint_type="Interface",
        private_dns_enabled=True,
        subnet_ids=interface_vpc_endpoint_subnet_ids,
        security_group_ids=[vpc_endpoint_security_group.id],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-kms-vpce",
                "Purpose": "Private KMS access from Lambda",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    aws.ec2.VpcEndpoint(
        "feedback-logs-vpc-endpoint",
        vpc_id=vpc.id,
        service_name=f"com.amazonaws.{context.region}.logs",
        vpc_endpoint_type="Interface",
        private_dns_enabled=True,
        subnet_ids=interface_vpc_endpoint_subnet_ids,
        security_group_ids=[vpc_endpoint_security_group.id],
        tags=context.component_tags(
            "network",
            {
                "Name": f"{vpc_name}-logs-vpce",
                "Purpose": "Private CloudWatch Logs access from Lambda subnets",
            },
        ),
        opts=pulumi.ResourceOptions(parent=vpc),
    )

    return NetworkResources(
        vpc=vpc,
        public_subnets=public_subnets,
        private_app_subnets=private_app_subnets,
        private_data_subnets=private_data_subnets,
        lambda_security_group=lambda_security_group,
        database_security_group=database_security_group,
    )
