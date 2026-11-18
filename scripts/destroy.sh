#!/usr/bin/env bash
# Deletes everything SeatSpot created, so nothing keeps running on your account.
set -euo pipefail
STACK="${STACK:-seatspot}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
aws s3 rm "s3://$BUCKET" --recursive --region "$REGION"
sam delete --stack-name "$STACK" --region "$REGION" --no-prompts
