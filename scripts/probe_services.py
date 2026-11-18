#!/usr/bin/env python3
"""Check which AWS services this account is allowed to use (read-only calls only)."""
import os
import boto3
from botocore.exceptions import ClientError, EndpointConnectionError

REGIONS = [r for r in os.environ.get("PROBE_REGIONS", "ap-south-1 us-east-1").split() if r]
CHECKS = [
    ("sts", "get_caller_identity", {}),
    ("cloudformation", "list_stacks", {}),
    ("dynamodb", "list_tables", {}),
    ("lambda", "list_functions", {}),
    ("apigatewayv2", "get_apis", {}),
    ("apigateway", "get_rest_apis", {}),
    ("s3", "list_buckets", {}),
    ("cloudfront", "list_distributions", {}),
    ("events", "list_rules", {}),
    ("scheduler", "list_schedules", {}),
    ("iam", "list_roles", {"MaxItems": 1}),
    ("logs", "describe_log_groups", {"limit": 1}),
    ("sqs", "list_queues", {}),
    ("sns", "list_topics", {}),
    ("ec2", "describe_vpcs", {}),
    ("rds", "describe_db_instances", {}),
    ("amplify", "list_apps", {}),
    ("apprunner", "list_services", {}),
    ("lightsail", "get_instances", {}),
    ("elasticbeanstalk", "describe_applications", {}),
    ("ecs", "list_clusters", {}),
    ("ecr", "describe_repositories", {}),
    ("cognito-idp", "list_user_pools", {"MaxResults": 1}),
    ("appsync", "list_graphql_apis", {}),
    ("ses", "list_identities", {}),
    ("ssm", "describe_parameters", {"MaxResults": 1}),
    ("secretsmanager", "list_secrets", {"MaxResults": 1}),
    ("kinesis", "list_streams", {}),
    ("bedrock", "list_foundation_models", {}),
    ("sagemaker", "list_domains", {}),
    ("codebuild", "list_projects", {}),
    ("cloudwatch", "list_dashboards", {}),
]

lines = []
for region in REGIONS:
    s = boto3.Session(region_name=region)
    ok, denied, other = [], [], []
    for svc, op, kw in CHECKS:
        try:
            getattr(s.client(svc), op)(**kw)
            ok.append(svc)
        except ClientError as e:
            msg = e.response["Error"].get("Message", "")
            code = e.response["Error"]["Code"]
            if "service control policy" in msg or code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation"):
                denied.append(svc + (" (SCP)" if "service control policy" in msg else ""))
            else:
                other.append(f"{svc}: {code}")
        except (EndpointConnectionError, Exception) as e:  # noqa: BLE001
            other.append(f"{svc}: {type(e).__name__}")
    block = [f"### {region}", f"- ALLOWED: {', '.join(ok) or 'none'}",
             f"- DENIED: {', '.join(denied) or 'none'}", f"- OTHER: {', '.join(other) or 'none'}"]
    print("\n".join(block), flush=True)
    lines += block

if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as fh:
        fh.write("## AWS service access probe\n" + "\n".join(lines) + "\n")
