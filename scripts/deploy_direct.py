#!/usr/bin/env python3
"""Deploy SeatSpot with direct AWS API calls (no CloudFormation).

Use this when CloudFormation is unavailable, e.g. accounts in an AWS
Organization whose policies block it. Creates the same resources as
template.yaml and is safe to re-run: existing resources are reused/updated.

Env: ADMIN_KEY (required), AWS_REGION (default ap-south-1), plus AWS credentials.
Needs: pip install boto3
"""
import io
import json
import mimetypes
import os
import pathlib
import sys
import time
import urllib.request
import zipfile

import boto3
from botocore.exceptions import ClientError

P = "seatspot"
REGION = os.environ.get("AWS_REGION") or "ap-south-1"
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")
ROOT = pathlib.Path(__file__).resolve().parent.parent

# AWS managed CloudFront policies
CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"


def step(msg):
    print(f"==> {msg}", flush=True)


def err_code(e):
    return e.response["Error"]["Code"]


def main():
    if len(ADMIN_KEY) < 8:
        sys.exit("Set ADMIN_KEY to a secret of at least 8 characters")

    s = boto3.Session(region_name=REGION)
    acct = s.client("sts").get_caller_identity()["Account"]
    ddb, iam, lam = s.client("dynamodb"), s.client("iam"), s.client("lambda")
    apigw, events, s3 = s.client("apigatewayv2"), s.client("events"), s.client("s3")
    cf, logs = s.client("cloudfront"), s.client("logs")

    # ---------- DynamoDB ----------
    table = f"{P}-seats"
    step(f"DynamoDB table {table}")
    try:
        ddb.describe_table(TableName=table)
    except ClientError as e:
        if err_code(e) != "ResourceNotFoundException":
            raise
        ddb.create_table(
            TableName=table,
            AttributeDefinitions=[{"AttributeName": "seatId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "seatId", "KeyType": "HASH"}],
            BillingMode="PROVISIONED",  # 5/5 is inside the always-free 25/25
            ProvisionedThroughput={"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
        )
    ddb.get_waiter("table_exists").wait(TableName=table)
    table_arn = ddb.describe_table(TableName=table)["Table"]["TableArn"]

    # ---------- IAM role for Lambda ----------
    role = f"{P}-lambda-role"
    step(f"IAM role {role}")
    trust = {
        "Version": "2012-10-17",
        "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}],
    }
    try:
        role_arn = iam.get_role(RoleName=role)["Role"]["Arn"]
    except ClientError as e:
        if err_code(e) != "NoSuchEntity":
            raise
        role_arn = iam.create_role(RoleName=role, AssumeRolePolicyDocument=json.dumps(trust))["Role"]["Arn"]
    iam.put_role_policy(
        RoleName=role,
        PolicyName=f"{P}-access",
        PolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                               "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query"],
                    "Resource": f"arn:aws:dynamodb:*:{acct}:table/{table}",
                },
                {
                    "Effect": "Allow",
                    "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                    "Resource": "*",
                },
            ],
        }),
    )

    # ---------- Lambda functions ----------
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / "backend/package.json", "package.json")
        for f in sorted((ROOT / "backend/src").glob("*.mjs")):
            z.write(f, f"src/{f.name}")
    code = buf.getvalue()

    def upsert_function(name, handler, env):
        step(f"Lambda {name}")
        common = dict(Role=role_arn, Handler=handler, Runtime="nodejs22.x", MemorySize=256,
                      Timeout=10, Environment={"Variables": env})
        try:
            lam.get_function(FunctionName=name)
            exists = True
        except ClientError as e:
            if err_code(e) != "ResourceNotFoundException":
                raise
            exists = False
        if exists:
            lam.update_function_code(FunctionName=name, ZipFile=code)
            lam.get_waiter("function_updated_v2").wait(FunctionName=name)
            lam.update_function_configuration(FunctionName=name, **common)
        else:
            for attempt in range(15):  # a brand-new role takes a few seconds to be usable
                try:
                    lam.create_function(FunctionName=name, Architectures=["arm64"], Code={"ZipFile": code}, **common)
                    break
                except ClientError as e:
                    if err_code(e) == "InvalidParameterValueException" and attempt < 14:
                        time.sleep(4)
                        continue
                    raise
            lam.get_waiter("function_active_v2").wait(FunctionName=name)
        lam.get_waiter("function_updated_v2").wait(FunctionName=name)
        try:  # keep logs for 14 days
            logs.create_log_group(logGroupName=f"/aws/lambda/{name}")
        except ClientError:
            pass
        try:
            logs.put_retention_policy(logGroupName=f"/aws/lambda/{name}", retentionInDays=14)
        except ClientError:
            pass
        return lam.get_function(FunctionName=name)["Configuration"]["FunctionArn"]

    def allow_invoke(fn, sid, principal, source_arn):
        try:
            lam.add_permission(FunctionName=fn, StatementId=sid, Action="lambda:InvokeFunction",
                               Principal=principal, SourceArn=source_arn)
        except ClientError as e:
            if err_code(e) != "ResourceConflictException":
                raise

    api_fn = f"{P}-api"
    sweeper_fn = f"{P}-sweeper"
    api_fn_arn = upsert_function(api_fn, "src/handler.api", {"TABLE_NAME": table, "ADMIN_KEY": ADMIN_KEY})
    sweeper_arn = upsert_function(sweeper_fn, "src/handler.sweeper", {"TABLE_NAME": table})

    # ---------- API Gateway (HTTP API, quick create -> $default route + stage) ----------
    step("API Gateway HTTP API")
    api = next((a for a in apigw.get_apis(MaxResults="500")["Items"] if a["Name"] == f"{P}-api"), None)
    cors = {"AllowOrigins": ["*"], "AllowMethods": ["GET", "POST", "OPTIONS"],
            "AllowHeaders": ["content-type", "x-seat-token", "x-admin-key"]}
    if not api:
        api = apigw.create_api(Name=f"{P}-api", ProtocolType="HTTP", Target=api_fn_arn, CorsConfiguration=cors)
    api_id, api_url = api["ApiId"], api["ApiEndpoint"]
    allow_invoke(api_fn, "apigateway-invoke", "apigateway.amazonaws.com",
                 f"arn:aws:execute-api:{REGION}:{acct}:{api_id}/*")

    # ---------- EventBridge: sweeper every 5 minutes ----------
    step("EventBridge schedule (every 5 min)")
    rule = f"{P}-sweeper-every-5-min"
    rule_arn = events.put_rule(Name=rule, ScheduleExpression="rate(5 minutes)", State="ENABLED")["RuleArn"]
    events.put_targets(Rule=rule, Targets=[{"Id": "sweeper", "Arn": sweeper_arn}])
    allow_invoke(sweeper_fn, "events-invoke", "events.amazonaws.com", rule_arn)

    # ---------- S3 (private) ----------
    bucket = f"{P}-site-{acct}-{REGION}"
    step(f"S3 bucket {bucket}")
    try:
        if REGION == "us-east-1":
            s3.create_bucket(Bucket=bucket)
        else:
            s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": REGION})
    except ClientError as e:
        if err_code(e) != "BucketAlreadyOwnedByYou":
            raise
    s3.put_public_access_block(Bucket=bucket, PublicAccessBlockConfiguration={
        "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})

    # ---------- CloudFront ----------
    step("CloudFront distribution")
    oac_name = f"{P}-oac-{REGION}"
    oacs = cf.list_origin_access_controls().get("OriginAccessControlList", {}).get("Items", []) or []
    oac = next((o for o in oacs if o["Name"] == oac_name), None)
    if oac:
        oac_id = oac["Id"]
    else:
        oac_id = cf.create_origin_access_control(OriginAccessControlConfig={
            "Name": oac_name, "Description": "SeatSpot site bucket", "SigningProtocol": "sigv4",
            "SigningBehavior": "always", "OriginAccessControlOriginType": "s3"})["OriginAccessControl"]["Id"]

    comment = f"SeatSpot library seat finder ({REGION})"
    dists = cf.list_distributions().get("DistributionList", {}).get("Items", []) or []
    dist = next((d for d in dists if d.get("Comment") == comment), None)
    if not dist:
        api_domain = api_url.replace("https://", "")
        dist = cf.create_distribution(DistributionConfig={
            "CallerReference": f"{P}-{REGION}-{int(time.time())}",
            "Comment": comment,
            "Enabled": True,
            "DefaultRootObject": "index.html",
            "PriceClass": "PriceClass_200",
            "HttpVersion": "http2and3",
            "Origins": {"Quantity": 2, "Items": [
                {"Id": "site", "DomainName": f"{bucket}.s3.{REGION}.amazonaws.com",
                 "OriginAccessControlId": oac_id, "S3OriginConfig": {"OriginAccessIdentity": ""}},
                {"Id": "api", "DomainName": api_domain,
                 "CustomOriginConfig": {"HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "https-only",
                                        "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]}}},
            ]},
            "DefaultCacheBehavior": {
                "TargetOriginId": "site", "ViewerProtocolPolicy": "redirect-to-https", "Compress": True,
                "CachePolicyId": CACHING_OPTIMIZED,
                "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
                                   "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
            },
            "CacheBehaviors": {"Quantity": 1, "Items": [{
                "PathPattern": "/api/*", "TargetOriginId": "api", "ViewerProtocolPolicy": "https-only",
                "CachePolicyId": CACHING_DISABLED, "OriginRequestPolicyId": ALL_VIEWER_EXCEPT_HOST,
                "Compress": True,
                "AllowedMethods": {"Quantity": 7, "Items": ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
                                   "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
            }]},
        })["Distribution"]
    dist_id, dist_domain = dist["Id"], dist["DomainName"]
    dist_arn = f"arn:aws:cloudfront::{acct}:distribution/{dist_id}"

    s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow", "Principal": {"Service": "cloudfront.amazonaws.com"}, "Action": "s3:GetObject",
            "Resource": f"arn:aws:s3:::{bucket}/*", "Condition": {"StringEquals": {"AWS:SourceArn": dist_arn}},
        }],
    }))

    # ---------- Upload website ----------
    step("Uploading website")
    site = ROOT / "frontend"
    for f in sorted(p for p in site.rglob("*") if p.is_file()):
        key = f.relative_to(site).as_posix()
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.suffix in (".js", ".mjs"):
            ctype = "text/javascript"
        elif f.suffix == ".woff2":
            ctype = "font/woff2"
        s3.put_object(Bucket=bucket, Key=key, Body=f.read_bytes(), ContentType=ctype, CacheControl="max-age=60")
    cf.create_invalidation(DistributionId=dist_id, InvalidationBatch={
        "Paths": {"Quantity": 1, "Items": ["/*"]}, "CallerReference": str(time.time())})

    # ---------- Seed seats ----------
    step("Seeding seats")
    for attempt in range(10):  # a brand-new API can take a few seconds to answer
        try:
            req = urllib.request.Request(f"{api_url}/admin/seed", method="POST", headers={"x-admin-key": ADMIN_KEY})
            print(urllib.request.urlopen(req, timeout=15).read().decode())
            break
        except Exception as e:  # noqa: BLE001
            if attempt == 9:
                print(f"::warning::Seeding failed ({e}); re-run the deploy to retry.")
            time.sleep(5)

    site_url = f"https://{dist_domain}"
    print(f"""
Done!
  App:        {site_url}
  Desk QRs:   {site_url}/qr.html
  API:        {api_url}/seats
(CloudFront can take a few minutes to go live after the first deploy.)""")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write(f"## SeatSpot is live\n- App: {site_url}\n- Desk QR codes: {site_url}/qr.html\n- API: {api_url}/seats\n")


if __name__ == "__main__":
    try:
        main()
    except ClientError as e:
        op = e.operation_name
        msg = e.response["Error"].get("Message", "")
        print(f"::error::AWS refused {op}: {msg}")
        sys.exit(1)
