# SeatSpot: live library seat finder

**The problem:** at exam time our library fills up fast. Students walk across campus and climb two floors only to find no free seat. Seats are also "reserved" all day with a bag and nobody sitting there.

**The solution:** SeatSpot is a web app that shows which library seats are free right now, floor by floor. Every desk has a QR code. A student scans it to check in, and the seat turns red for everyone. Seats are freed **automatically**:

| Situation | What happens |
|---|---|
| Student checks in | Seat is held for **2 h**. One tap on "I'm still here" extends it |
| Student goes for chai | "Break · 20 min" marks the seat amber. If they're not back in 20 min, the seat is freed |
| Bag on seat, nobody around | Anyone can tap **Report unattended**. Unless the holder confirms within **15 min**, the seat is freed |
| Student forgets to check out | The hold runs out and a scheduled Lambda releases the seat |
| One person, many seats | Blocked: each roll number can hold only one seat. The roll number is stored only as a one-way hash |

Other features: a ⚡ power-socket filter, a free/total count for each zone and floor, refresh every 10 s, a mobile-first layout with dark mode, and a printable QR sheet for every desk (`/qr.html`).

## Architecture (all AWS Free Tier)

```
 Phone ──HTTPS──▶ CloudFront ──/*──────▶ S3 (private, OAC)      static site
                      │
                      └──/api/*──▶ API Gateway (HTTP API) ──▶ Lambda "api" ──▶ DynamoDB (Seats)
                                                                                   ▲
                       EventBridge Scheduler (every 5 min) ──▶ Lambda "sweeper" ───┘
```

| Service | Role | Free Tier fit |
|---|---|---|
| **Amazon S3** | Hosts the static frontend (private bucket) | 5 GB |
| **Amazon CloudFront** | HTTPS, caching, one URL for site and API | 1 TB/month always free |
| **Amazon API Gateway (HTTP API)** | REST endpoints | 1M calls/month (12 months) |
| **AWS Lambda** (Node.js 22, arm64) | Business logic, plus a sweeper that releases expired seats | 1M requests/month always free |
| **Amazon DynamoDB** | Seat state, with optimistic locking (`version`) so two students can't grab the same seat | 25 RCU/25 WCU + 25 GB always free (the table uses 5/5) |
| **Amazon EventBridge Scheduler** | Runs the sweeper every 5 min (~8.6k runs/month) | 14M invocations/month free |
| **Amazon CloudWatch Logs** | Lambda logs, kept for 14 days | 5 GB free |
| **AWS SAM / CloudFormation** | Infrastructure as code: the whole stack is one template | free |

### API

| Method & path | Body / headers | Purpose |
|---|---|---|
| `GET /api/seats` | | All seats with public status (never tokens or identities) |
| `GET /api/stats` | | Totals and per-zone free counts |
| `POST /api/seats/{id}/checkin` | `{ "rollNo": "22CE1045" }` | Take a seat → returns a secret `token` |
| `POST /api/seats/{id}/extend` | `x-seat-token` | "I'm still here": hold for another 2 h and clear any reports |
| `POST /api/seats/{id}/break` | `x-seat-token` | Away for 20 min |
| `POST /api/seats/{id}/checkout` | `x-seat-token` | Leave |
| `POST /api/seats/{id}/report` | | Flag as unattended (hold cut to 15 min) |
| `POST /api/admin/seed` | `x-admin-key` | Create the seats from `backend/src/layout.mjs` |

## Run it locally (no AWS account needed)

```bash
cd main-project-g
```

```bash
node local/server.mjs
```

Open http://localhost:5174. The local server uses the same router and business logic as Lambda, with an in-memory store, and pre-fills some seats so the map looks busy. Set `DEMO=0` for an empty library. To check in to a specific seat, open http://localhost:5174/?seat=F1-S04 (this is the link a desk QR code points to).

Run the tests:

```bash
cd backend && npm test
```

## Deploy to AWS

Prerequisites: an AWS account, [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with `aws configure`, [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), and Node.js 22 (only needed for local runs).

```bash
cd main-project-g
```

```bash
ADMIN_KEY='choose-a-long-secret' ./scripts/deploy.sh
```

The script builds and deploys the stack (default region `ap-south-1` Mumbai; override with `AWS_REGION`), uploads the site, creates the seats, and prints your app URL (`https://xxxx.cloudfront.net`). That URL is the **project link** for the submission. On the first deploy CloudFront needs a few minutes before the URL works.

To match your own library, edit `backend/src/layout.mjs` and deploy again. New seats are added; existing ones are left alone. Then open `<your-url>/qr.html`, print it, and stick the codes on the desks.

To tear everything down afterwards:

```bash
./scripts/destroy.sh
```

## Project layout

```
main-project-g/
├── template.yaml          # AWS SAM: DynamoDB, Lambdas, HTTP API, schedule, S3, CloudFront
├── backend/
│   ├── src/handler.mjs    # Lambda entry points + router
│   ├── src/service.mjs    # seat rules (check-in, break, report, expiry)
│   ├── src/stores.mjs     # DynamoDB + in-memory adapters with optimistic locking
│   ├── src/layout.mjs     # floors / zones / seats
│   └── test/              # node:test unit tests
├── frontend/              # static site: index.html, app.js, styles.css, qr.html
├── local/server.mjs       # local dev server
└── scripts/               # deploy.sh, destroy.sh
```

## Design notes

- **No double booking:** every write is a conditional DynamoDB `PutItem` on the item's `version`. If two phones tap the same seat at once, only one wins and the other gets "Seat was updated by someone else".
- **Privacy:** roll numbers are never stored, only a truncated SHA-256 hash, used to enforce one seat per student. The public API shows only free / taken / away.
- **Security:** the seat token is random (144 bits) and stays only on the student's phone. Without it, nobody else can release or extend your seat.
- **Always correct even between sweeps:** reads treat an expired hold as free right away. The sweeper only tidies the data.
- **Zero dependencies at runtime:** Lambda uses the AWS SDK v3 that ships with the runtime. The frontend is plain HTML/CSS/JS, and the QR library is vendored (MIT).

## 60–90 second demo video script

1. **(0–10 s) Problem.** "Exam season: the library's full, and half the 'taken' seats are just bags."
2. **(10–25 s) Live map.** Open the CloudFront URL on your phone. Show the free count, the floor tabs, and the ⚡ filter.
3. **(25–45 s) Check in.** Scan a desk QR (print one from `/qr.html`), enter your roll number, and check in. Show the seat turn "you" and, on a second device or laptop, turn red.
4. **(45–60 s) Fairness.** Tap Break and show it turn amber with a 20-minute countdown. On the other device, tap a taken seat → **Report unattended**.
5. **(60–80 s) AWS.** Quick cuts: the CloudFormation stack resources, the DynamoDB item changing, and the sweeper's CloudWatch log "released expired seats".
6. **(80–90 s) Wrap.** "Serverless, Free Tier, deployable in one command."

## Deploy from GitHub (no local setup)

`.github/workflows/deploy.yml` deploys the stack on every push to `main`, or when you run it manually from the **Actions** tab. Add these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | Access key of an IAM user in your AWS account |
| `AWS_SECRET_ACCESS_KEY` | Its secret key |
| `ADMIN_KEY` | Any long random string (used to seed the seats) |

The run's summary page shows the live app URL. Until the secrets exist, the workflow skips deployment instead of failing.

### If CloudFormation is blocked on your account

Some AWS accounts (for example college or lab accounts inside an AWS Organization) block CloudFormation. Then `scripts/deploy_direct.py` creates the same resources with direct AWS API calls. The GitHub workflow switches to it automatically, or you can run it yourself:

```bash
pip install boto3
```

```bash
ADMIN_KEY='choose-a-long-secret' python3 scripts/deploy_direct.py
```

### If Lambda and DynamoDB are blocked too (new AWS "projects" free plan)

Some new AWS accounts (the free plan "projects" experience) only allow a subset of services. Run the **Check AWS access** workflow to see which. If Lambda and DynamoDB are blocked but Lightsail and S3 are allowed (in `us-east-1`), SeatSpot runs as:

```
 Phone ──HTTPS──▶ Amazon Lightsail container service (Node.js: website + API + 1-min sweeper)
                          │  snapshot after every change / load on start
                          ▼
                   Amazon S3 (private bucket, seats.json)   ◀── IAM user limited to that one file
```

The deploy workflow switches to this automatically (`scripts/deploy_lightsail.sh`, built from the `Dockerfile`). The same business logic and tests apply; only the hosting and storage change.
