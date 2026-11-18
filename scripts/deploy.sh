#!/usr/bin/env bash
# One-command deploy: builds + deploys the stack, uploads the website, seeds the seats.
# Needs: AWS CLI v2 (configured with `aws configure`) and AWS SAM CLI.
# Usage:  ADMIN_KEY=some-long-secret ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

STACK="${STACK:-seatspot}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
: "${ADMIN_KEY:?Set ADMIN_KEY to a secret of at least 8 characters}"

echo "==> Building and deploying stack '$STACK' to $REGION"
sam build --template-file template.yaml
sam deploy \
  --stack-name "$STACK" --region "$REGION" \
  --resolve-s3 --capabilities CAPABILITY_IAM \
  --parameter-overrides "AdminKey=$ADMIN_KEY" \
  --no-confirm-changeset --no-fail-on-empty-changeset

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
SITE_URL=$(out SiteUrl); API_URL=$(out ApiUrl); BUCKET=$(out BucketName); DIST=$(out DistributionId)

echo "==> Uploading website to s3://$BUCKET"
aws s3 sync frontend "s3://$BUCKET" --delete --region "$REGION"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' >/dev/null

echo "==> Seeding seats"
curl -fsS -X POST "$API_URL/admin/seed" -H "x-admin-key: $ADMIN_KEY"; echo

cat <<EOF

Done!
  App:        $SITE_URL
  Desk QRs:   $SITE_URL/qr.html
  API:        $API_URL/seats
(CloudFront can take a few minutes to go live after the first deploy.)
EOF
