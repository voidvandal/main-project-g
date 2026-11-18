#!/usr/bin/env bash
# Deploy SeatSpot to Amazon Lightsail containers + S3 (no Lambda/DynamoDB/CloudFormation).
# For AWS accounts where only some services are allowed (e.g. the new "projects"
# free plan experience). Safe to re-run.
# Needs: AWS CLI v2, Docker, lightsailctl plugin, jq. Env: ADMIN_KEY (optional here).
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_REGION="${AWS_REGION:-us-east-1}" AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}"
SERVICE="${SERVICE:-seatspot}"
POWER="${POWER:-nano}"
ACCT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="seatspot-data-$ACCT-$AWS_REGION"
APP_USER="seatspot-app"

echo "==> S3 bucket for seat data: $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  if [ "$AWS_REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null; fi
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "==> IAM user $APP_USER (can only read/write the seat data file)"
aws iam get-user --user-name "$APP_USER" >/dev/null 2>&1 || aws iam create-user --user-name "$APP_USER" >/dev/null
aws iam put-user-policy --user-name "$APP_USER" --policy-name seatspot-data --policy-document "$(jq -nc --arg b "$BUCKET" '{
  Version: "2012-10-17",
  Statement: [{Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "arn:aws:s3:::\($b)/seats.json"},
              {Effect: "Allow", Action: ["s3:ListBucket"], Resource: "arn:aws:s3:::\($b)"}]}')"
# Rotate: drop old keys, make a fresh one for this deployment.
for k in $(aws iam list-access-keys --user-name "$APP_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name "$APP_USER" --access-key-id "$k"
done
read -r APP_KEY_ID APP_KEY_SECRET < <(aws iam create-access-key --user-name "$APP_USER" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
[ -n "${GITHUB_ACTIONS:-}" ] && { echo "::add-mask::$APP_KEY_ID"; echo "::add-mask::$APP_KEY_SECRET"; }

echo "==> Lightsail container service $SERVICE ($POWER)"
if ! aws lightsail get-container-services --service-name "$SERVICE" >/dev/null 2>&1; then
  aws lightsail create-container-service --service-name "$SERVICE" --power "$POWER" --scale 1 >/dev/null
fi
wait_state() { # wait until the service is in one of the given states
  for _ in $(seq 1 90); do
    st=$(aws lightsail get-container-services --service-name "$SERVICE" --query 'containerServices[0].state' --output text)
    [[ " $* " == *" $st "* ]] && return 0
    echo "   service state: $st"; sleep 10
  done
  echo "Timed out waiting for $SERVICE (last state: $st)"; return 1
}
wait_state READY RUNNING

echo "==> Building and pushing the container image"
docker build -t seatspot:latest .
IMAGE=$(aws lightsail push-container-image --service-name "$SERVICE" --label app --image seatspot:latest 2>&1 \
  | tee /dev/stderr | grep -o ':'"$SERVICE"'\.app\.[0-9]*' | tail -1)
[ -n "$IMAGE" ] || { echo "Could not push the image"; exit 1; }

echo "==> Deploying $IMAGE"
CONTAINERS=$(jq -nc --arg img "$IMAGE" --arg b "$BUCKET" --arg r "$AWS_REGION" \
  --arg id "$APP_KEY_ID" --arg sec "$APP_KEY_SECRET" --arg admin "${ADMIN_KEY:-}" '{
  app: {image: $img, ports: {"8080": "HTTP"}, environment: {
    PORT: "8080", DEMO: "0", DATA_BUCKET: $b, AWS_REGION: $r,
    AWS_ACCESS_KEY_ID: $id, AWS_SECRET_ACCESS_KEY: $sec, ADMIN_KEY: $admin}}}')
aws lightsail create-container-service-deployment --service-name "$SERVICE" --containers "$CONTAINERS" \
  --public-endpoint '{"containerName":"app","containerPort":8080,"healthCheck":{"path":"/api/health","successCodes":"200"}}' >/dev/null
sleep 15
wait_state RUNNING READY
dep=$(aws lightsail get-container-services --service-name "$SERVICE" --query 'containerServices[0].currentDeployment.state' --output text)
[ "$dep" = ACTIVE ] || { echo "Deployment state: $dep"; aws lightsail get-container-log --service-name "$SERVICE" --container-name app | tail -40 || true; exit 1; }

URL=$(aws lightsail get-container-services --service-name "$SERVICE" --query 'containerServices[0].url' --output text)
URL="${URL%/}"
echo "==> Checking $URL"
curl -fsS "$URL/api/stats"; echo

cat <<EOF

Done!
  App:        $URL
  Desk QRs:   $URL/qr.html
  API:        $URL/api/seats
EOF
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '## SeatSpot is live\n- App: %s\n- Desk QR codes: %s/qr.html\n- API: %s/api/seats\n' "$URL" "$URL" "$URL" >> "$GITHUB_STEP_SUMMARY"
fi
