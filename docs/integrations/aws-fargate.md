# AWS Fargate + ALB + Route53 Integration Spec

**Source docs:**
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html (task sizing)
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking-awsvpc.html
- https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html
- https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html
- https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html
- https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html
- https://docs.aws.amazon.com/elasticloadbalancing/latest/application/sticky-sessions.html (partial — page was gated)
- https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-elb-load-balancer.html
- https://aws.amazon.com/fargate/pricing/

**Fetched:** 2026-04-16
**For:** Robot Dojo — tunnel gateway service (single Fargate task behind ALB), WebSocket traffic with sticky sessions keyed to `user_id`. 99 users, low volume.

---

## Authentication

**IAM + AWS SDK v3 / AWS CLI v2.** No API keys embedded in code. Use task IAM roles for any AWS calls from inside the Fargate container.

- **Task execution role** (Fargate uses to pull image, write logs): `ecsTaskExecutionRole` with `AmazonECSTaskExecutionRolePolicy`.
- **Task role** (container's application code uses): least-privilege policy — e.g. `secretsmanager:GetSecretValue` for our scoped secrets only.

Human-side deploys from the CLI assume a role via `aws sso login` → short-lived creds.

---

## Region

**us-east-1 (N. Virginia)** for launch. Everything in one region: VPC, Fargate cluster, ALB, ACM cert, Route 53 hosted zone. CloudFront (if added later) also sources cert from us-east-1 — no conflict.

Pricing numbers below are us-east-1.

---

## Fargate

### Task sizing

Minimum CPU/memory combinations (Linux x86):
| CPU | Memory options |
|---|---|
| **256 (0.25 vCPU)** | 512 MiB, 1 GB, 2 GB |
| 512 (0.5 vCPU) | 1–4 GB |
| 1024 (1 vCPU) | 2–8 GB |
| 2048 (2 vCPU) | 4–16 GB (1 GB steps) |
| 4096 (4 vCPU) | 8–30 GB (1 GB steps) |
| 8192 (8 vCPU) | 16–60 GB (4 GB steps, platform 1.4.0+) |
| 16384 (16 vCPU) | 32–120 GB (8 GB steps, platform 1.4.0+) |

**Robot Dojo tunnel gateway choice: `0.25 vCPU / 512 MiB`** — the minimum. WebSocket fan-out for 99 users is trivial. Scale up only when we measure load.

### Pricing (Linux x86, us-east-1)

- vCPU: **$0.04048 per vCPU-hour** ($0.000011244/sec)
- Memory: **$0.004446 per GB-hour** ($0.000001235/GB/sec)
- Ephemeral storage: $0.0001109 per GB-hour (20 GB free per task)

**Our cost for single 0.25 vCPU / 0.5 GB task running 24/7:**
- CPU: 0.25 × $0.04048 × 24 × 30 = **$7.29/mo**
- Memory: 0.5 × $0.004446 × 24 × 30 = **$1.60/mo**
- **Total: ~$8.90/mo** for the tunnel gateway task.

(Graviton ARM64 is ~20% cheaper — consider for v0.1 if the runtime is ARM-compatible.)

Fargate Spot: up to 70% off with 2-minute interruption warning. **Not appropriate for our tunnel gateway** — interruptions would drop WebSocket sessions.

### Platform versions

- **Linux: `1.4.0`** (current, required for 8/16 vCPU and ephemeral-storage tuning). Set explicitly; `LATEST` defaults to 1.4.0 but pin it.
- Windows: not applicable.

### Launch type vs capacity providers

Use **capacity providers** (not raw launch type): `FARGATE` for our service, optionally a `FARGATE_SPOT` fallback later. Capacity providers let us add Spot without redeploying.

### Task definition (canonical fragment)

```json
{
  "family": "robotdojo-tunnel",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::ACCOUNT:role/robotdojo-tunnel-task",
  "runtimePlatform": {
    "operatingSystemFamily": "LINUX",
    "cpuArchitecture": "X86_64"
  },
  "containerDefinitions": [
    {
      "name": "tunnel",
      "image": "ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/robotdojo-tunnel:<sha>",
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/robotdojo-tunnel",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "tunnel"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 10
      }
    }
  ]
}
```

---

## Networking (awsvpc mode)

Fargate **requires** `networkMode: awsvpc`. Each task gets its own ENI and private IP.

### VPC requirements

- Enable `enableDnsHostnames` and `enableDnsSupport` on the VPC.
- **At least 2 subnets in 2 AZs** for ALB (e.g. `us-east-1a`, `us-east-1b`).
- Subnet choice:
  - **Private subnets + NAT gateway** — preferred for production (task has no public IP, pulls images via NAT). NAT gateway costs $0.045/hr (~$32/mo) + $0.045/GB data. **For 99 users this may be overkill.**
  - **Public subnets + `assignPublicIp: ENABLED`** — cheaper, acceptable for a single tunnel task if the security group is tight. Pragma pick for launch: public subnet + locked-down SG.

### Security groups

- **ALB SG** (`alb-sg`): inbound 443 from 0.0.0.0/0. Outbound to `tunnel-sg` on 8080.
- **Tunnel task SG** (`tunnel-sg`): inbound 8080 from `alb-sg` only. Outbound 443 to 0.0.0.0/0 (ECR, Secrets Manager, Stripe, Alchemy).

### awsvpcConfiguration (service definition fragment)

```json
{
  "networkConfiguration": {
    "awsvpcConfiguration": {
      "subnets": ["subnet-aaa", "subnet-bbb"],
      "securityGroups": ["sg-tunnel-task"],
      "assignPublicIp": "ENABLED"
    }
  }
}
```

Max 16 subnets, 5 security groups per task.

### Service-linked role

One-time per account:
```bash
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com
```

---

## Application Load Balancer

**Use ALB, not NLB**, because:
1. ALB has native WebSocket upgrade support (layer-7 HTTP upgrade).
2. ALB supports application-based sticky sessions (cookie), which we need to pin a user's WS to the same task.
3. NLB is layer-4: it "works" for WS but can't do cookie stickiness.

### Listener

- **Protocol:** HTTPS on port 443.
- **HTTP → HTTPS redirect** on port 80 (second listener with a fixed redirect action).
- **TLS policy:** `ELBSecurityPolicy-TLS13-1-2-2021-06` (modern, TLS 1.3 preferred, TLS 1.2 allowed).

WebSocket: client sends `Upgrade: websocket` / `Connection: Upgrade`; ALB upgrades the HTTP/1.1 connection and holds it open to the target. No special config needed beyond idle-timeout tuning.

HTTP/2: enabled by default (`routing.http2.enabled=true`). Up to 128 parallel requests per connection. Server-push not supported.

### Idle timeout

- Default: **60 seconds**.
- **Tune to `3600` (1 hour)** for our tunnel: WebSocket sessions may be idle between user messages. Attribute: `idle_timeout.timeout_seconds`.
- Clients must still send WS ping frames at least every `idle_timeout` to keep the connection alive (60s pings are safe).

### Target group

- **Target type: `ip`** (required for Fargate awsvpc). Not `instance`.
- **Protocol:** HTTP, port 8080 (container port).
- **Protocol version:** HTTP/1.1 (WebSocket requires 1.1 upgrade).
- **Health check:**
  - Path: `/health` (we implement a no-op 200 OK)
  - Interval: 30s (default)
  - Timeout: 5s (default)
  - Healthy threshold: 5 (default) — or lower to 2 for faster bring-up
  - Unhealthy threshold: 2 (default)
  - Matcher: `200`
- **Deregistration delay:** 30s (default is 300; shorten because our task restarts shouldn't drain for 5 min).

### Sticky sessions

- **Application-based stickiness** with custom cookie (e.g. `RDUSER`). Our tunnel sets the cookie per user_id on first connect.
- Alternative: **duration-based stickiness** (`AWSALB` cookie, default 1 day, max 7 days). Simpler but random assignment; doesn't follow user_id across incognito/device switches.
- **For launch: duration-based, 24-hour cookie.** We only have one task; stickiness is insurance against future scale-out.

Enable per target group:
```bash
aws elbv2 modify-target-group-attributes \
  --target-group-arn <arn> \
  --attributes Key=stickiness.enabled,Value=true \
               Key=stickiness.type,Value=lb_cookie \
               Key=stickiness.lb_cookie.duration_seconds,Value=86400
```

### ACM certificate

- **Must be in the same region as the ALB** (us-east-1). CloudFront certs go in us-east-1 too; ALB certs match the ALB's region.
- Request a cert for `robotdojo.ai` and `*.robotdojo.ai` (wildcard covers `api.`, `tunnel.`, etc.).
- DNS validation via Route 53 (one-click in the ACM console).
- Attach to HTTPS listener as the default cert. SNI list extras (multi-domain) added separately; we only need one for launch.

---

## Route 53

### Hosted zone

`robotdojo.ai` — already registered via Namecheap/GoDaddy. Create a public hosted zone in Route 53 and update the registrar's nameservers to point to Route 53's NS records.

### Alias record for ALB

Alias (not CNAME) — supports zone apex and is free to query.

**Record:**
- Name: `tunnel.robotdojo.ai` (subdomain; avoids coupling the apex to one ALB)
- Type: `A`
- Alias: **Yes**
- Alias target: `dualstack.robotdojo-alb-xxx.us-east-1.elb.amazonaws.com` (Route 53 prepends `dualstack.` automatically for same-account ALBs; manual prepend if cross-account)
- Evaluate target health: Yes
- TTL: N/A for alias (Route 53 manages)

**Changes propagate in ~60 seconds.**

### CNAME alternative (not preferred)

Only relevant for same-account subdomains where you explicitly want a CNAME. Do not CNAME the apex — it violates RFC 1912.

---

## Cost model (monthly, 99 users, us-east-1)

| Component | Cost |
|---|---|
| Fargate task (0.25 vCPU / 0.5 GB, 24/7) | ~$8.90 |
| ALB (fixed) | ~$16.43 ($0.0225/hr × 730) |
| ALB LCU (low traffic) | ~$5–10 |
| Data transfer out | ~$1–5 (100s of KB/user/day) |
| Route 53 hosted zone | $0.50 |
| ACM cert | $0 (free for ACM-issued) |
| ECR (image storage, <1 GB) | ~$0.10 |
| CloudWatch Logs (minimal) | ~$1 |
| **Total** | **~$35–45/mo** |

---

## Gotchas / footguns

1. **ALB, not NLB, for WebSocket + stickiness.** NLB is layer-4; stickiness is source-IP only and breaks behind mobile carrier NAT.
2. **Target type must be `ip`** for awsvpc. `instance` fails silently for Fargate.
3. **ACM cert region must match ALB region.** Requesting in us-east-2 while ALB is us-east-1 → the cert doesn't appear in the dropdown.
4. **Route 53 alias TTLs are managed by Route 53.** Don't try to set one.
5. **Public subnet + no public IP = no internet.** Fargate needs `assignPublicIp: ENABLED` when in a public subnet, even if you intend the SG to block inbound.
6. **Private subnet without NAT = ECR image pull fails.** Add VPC endpoints (`com.amazonaws.us-east-1.ecr.api`, `.ecr.dkr`, `.s3`, `.logs`, `.secretsmanager`) to skip NAT and still pull images. ~$7/mo per endpoint but cheaper than NAT for low traffic.
7. **Fargate 0.25 vCPU is small.** Node.js base memory alone is ~80 MB; plan for OOM if deps balloon. Move to 0.5 vCPU / 1 GB if tunnel exceeds 400 MB RSS.
8. **ALB idle timeout default is 60s.** WebSocket hangs after 1 min if you forget to raise it.
9. **Sticky cookies don't survive ALB IP churn.** If the ALB scales its own nodes, existing cookies still hash to the right target (ALB persists the mapping). Safe.
10. **Deregistration delay default is 300s.** During deploy, old tasks linger 5 min — cap to 30s for faster rollouts (acceptable: clients reconnect).
11. **Enable access logs** on ALB → S3 bucket with a 30-day lifecycle. Invaluable for debugging, cheap at our scale.
12. **Platform version `LATEST`** drifts silently. Pin `1.4.0` in the task definition.

---

## What we DON'T use

- **EC2 launch type** — we want serverless.
- **ECS Anywhere** — on-prem/hybrid, not relevant.
- **NLB / CLB** — ALB wins on WebSocket + cookie stickiness.
- **Fargate Spot** for the tunnel — interruption would drop user WS sessions.
- **Service Auto Scaling** — one task is enough for 99 users. Add when we measure load.
- **Service Discovery (Cloud Map)** — only one task; Route 53 + ALB suffices.
- **App Mesh / Service Connect** — no service-to-service traffic yet.
- **Windows containers** — Linux only.
- **CloudFront in front of ALB** — adds latency for WebSocket and isn't needed for 99 users. Revisit for static asset delivery on the marketing site.
- **Load Balancer target optimizer** — **do not enable**: it explicitly disables WebSocket support for the target group.
