import base64
import time
from typing import Any

import boto3
import pulumi
from botocore.exceptions import ClientError
from pulumi.dynamic import CreateResult, DiffResult, Resource, ResourceProvider, UpdateResult

RETRYABLE_ERROR_CODES = {
    "DatabaseResumingException",
    "DatabaseUnavailableException",
    "InternalServerErrorException",
    "ServiceUnavailableError",
    "TooManyRequestsException",
}


def quote_sql_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def quote_sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class AuroraBootstrapProvider(ResourceProvider):
    def _execute_statement(self, client: Any, props: dict[str, Any], statement: str) -> None:
        for attempt in range(10):
            try:
                client.execute_statement(
                    resourceArn=props["cluster_arn"],
                    secretArn=props["secret_arn"],
                    database=props["database_name"],
                    continueAfterTimeout=True,
                    sql=statement,
                )
                return
            except ClientError as error:
                error_code = error.response.get("Error", {}).get("Code", "")
                if error_code not in RETRYABLE_ERROR_CODES or attempt == 9:
                    raise
                time.sleep(min(2**attempt, 30))

    def _load_secret_value(self, region: str, secret_id: str) -> str:
        client = boto3.client("secretsmanager", region_name=region)
        response = client.get_secret_value(SecretId=secret_id)
        secret_string = response.get("SecretString")
        if secret_string is not None:
            return secret_string

        secret_binary = response.get("SecretBinary")
        if secret_binary is None:
            raise ValueError(f"Secret '{secret_id}' did not include a string or binary value.")

        decoded_secret = base64.b64decode(secret_binary)
        return decoded_secret.decode("utf-8")

    def _build_omni_statements(self, props: dict[str, Any]) -> list[str]:
        omni_username = props.get("omni_username")
        omni_password_secret_id = props.get("omni_password_secret_id")
        if omni_username is None and omni_password_secret_id is None:
            return []
        if not omni_username or not omni_password_secret_id:
            raise ValueError(
                "Set both 'omni_username' and 'omni_password_secret_id' when bootstrapping Omni."
            )

        omni_password = self._load_secret_value(props["region"], omni_password_secret_id)
        if not omni_password:
            raise ValueError(f"Secret '{omni_password_secret_id}' must not be empty.")

        quoted_omni_username = quote_sql_identifier(omni_username)
        quoted_omni_password = quote_sql_literal(omni_password)

        return [
            (
                "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = "
                f"{quote_sql_literal(omni_username)}) THEN CREATE ROLE {quoted_omni_username} "
                f"LOGIN ENCRYPTED PASSWORD {quoted_omni_password}; ELSE ALTER ROLE "
                f"{quoted_omni_username} WITH LOGIN ENCRYPTED PASSWORD {quoted_omni_password}; "
                "END IF; END $$"
            ),
        ]

    def _run(self, props: dict[str, Any]) -> None:
        client = boto3.client("rds-data", region_name=props["region"])
        for statement in [*self._build_omni_statements(props), *props["statements"]]:
            if statement.strip():
                self._execute_statement(client, props, statement)

    def create(self, props: dict[str, Any]) -> CreateResult:
        self._run(props)
        return CreateResult(id_=props["resource_id"], outs=props)

    def diff(self, _id: str, olds: dict[str, Any], news: dict[str, Any]) -> DiffResult:
        tracked_keys = (
            "cluster_arn",
            "secret_arn",
            "database_name",
            "region",
            "resource_id",
            "statements",
            "omni_username",
            "omni_password_secret_id",
        )
        changes = any(olds.get(key) != news.get(key) for key in tracked_keys)
        return DiffResult(changes=changes, replaces=[])

    def update(self, _id: str, olds: dict[str, Any], news: dict[str, Any]) -> UpdateResult:
        del olds
        self._run(news)
        return UpdateResult(outs=news)


class AuroraBootstrap(Resource):
    def __init__(
        self,
        resource_name: str,
        *,
        cluster_arn: pulumi.Input[str],
        secret_arn: pulumi.Input[str],
        database_name: pulumi.Input[str],
        region: pulumi.Input[str],
        statements: pulumi.Input[list[str]],
        omni_username: pulumi.Input[str] | None = None,
        omni_password_secret_id: pulumi.Input[str] | None = None,
        opts: pulumi.ResourceOptions | None = None,
    ) -> None:
        props: dict[str, Any] = {
            "cluster_arn": cluster_arn,
            "secret_arn": secret_arn,
            "database_name": database_name,
            "region": region,
            "resource_id": resource_name,
            "statements": statements,
        }
        if omni_username is not None:
            props["omni_username"] = omni_username
        if omni_password_secret_id is not None:
            props["omni_password_secret_id"] = omni_password_secret_id

        super().__init__(AuroraBootstrapProvider(), resource_name, props, opts)
