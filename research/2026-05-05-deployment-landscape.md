# Application Deployment: Industry Survey

## The Spectrum of Deployment Approaches

---

### 1. Manual SSH + Copy Files

**How it works:** SSH into server, copy files, restart processes.

**When appropriate:** Solo side projects, learning environments, emergency hotfixes.

**Pros:** Zero tooling, full control, easy to understand.

**Cons:** No repeatability, no rollback, downtime, state drift, doesn't scale.

---

### 2. Shell Scripts + rsync

**How it works:** A `deploy.sh` automates SSH steps. `rsync` syncs only changed files. Numbered release directories with symlink swap (Capistrano pattern) enable rollback.

```bash
#!/bin/bash
set -euo pipefail
RELEASE="releases/$(date +%Y%m%d-%H%M%S)"
rsync -avz --delete ./dist/ user@server:/var/www/app/$RELEASE/
ssh user@server "ln -sfn /var/www/app/$RELEASE /var/www/app/current && systemctl restart app"
```

**When appropriate:** 1-3 person teams, single server, compiled binaries or static assets.

**Pros:** Simple, readable, fast delta transfer, easy symlink rollback.

**Cons:** Server-mutable, no isolation, secrets ad-hoc, no multi-server.

**Tools:** rsync, Capistrano, Deployer, Fabric

---

### 3. Configuration Management (Ansible, Chef, Puppet)

**How it works:** Declare desired server state; tool converges reality to match. Ansible is agentless (push via SSH), Chef/Puppet use server agents (pull model).

**When appropriate:** 5-50+ servers, reproducible provisioning needed, mixed fleets.

**Pros:** Idempotent, full server config as code, safe to re-run.

**Cons:** YAML verbosity at scale, still mutates live servers, slow for frequent deploys.

**Tools:** Ansible, Chef, Puppet, SaltStack

---

### 4. Container-Based: Docker + docker-compose

**How it works:** App packaged as Docker image. `docker-compose.yml` declares services. Deploy: build → push to registry → pull on server → `docker compose up -d`.

**When appropriate:** 1-10 person teams, 1-3 servers, multiple services on one machine.

**Pros:** Immutable artifacts, trivial rollback (old image tag), dependency isolation, huge ecosystem.

**Cons:** Multi-host is DIY, zero-downtime needs extra work, image build times, single VPS not HA.

**Tools:** Docker, Docker Compose, Podman, BuildKit, GHCR

---

### 5. Container Orchestration: Kubernetes and Nomad

**How it works:** Distributed scheduler managing containers across a cluster. K8s: Pods, Deployments (replicas + update strategy), Services, Ingress. Nomad: simpler, multi-runtime.

**When appropriate:** 10+ person teams, multiple services, HA requirements, horizontal scaling.

**Pros:** Built-in rolling deploys, health checks, self-healing, horizontal scaling, massive ecosystem.

**Cons:** Enormous operational complexity, high resource overhead (control plane needs 2-4 cores / 4-8 GB), overkill for <10 services, managed k8s costs $200-500+/month minimum.

**Tools:** kubectl, Helm, k9s, cert-manager; Nomad: Consul, Vault, Terraform

---

### 6. Serverless / PaaS

**How it works:** Push code; platform handles provisioning, scaling, TLS, routing, databases.

| Platform | Model | Pricing |
|---|---|---|
| Heroku | Git push, buildpacks | $7+/dyno, expensive at scale |
| Fly.io | Firecracker micro-VMs, global | $5-20/mo small apps |
| Railway | GitHub connect, auto-detect | Usage-based |
| Render | Similar to Railway | $7/mo+ per service |
| Vercel/Netlify | Frontend + serverless functions | Free tier, not for servers |

**When appropriate:** Solo devs, early startups, zero DevOps overhead wanted, time-to-market priority.

**Pros:** Fastest time to production, automatic everything, no server maintenance.

**Cons:** Vendor lock-in, expensive at scale, less control, cold starts.

---

### 7. GitOps: ArgoCD and Flux

**How it works:** Desired state declared in Git; automated operator continuously reconciles cluster to match. No `kubectl apply` from CI — the cluster pulls its own config.

**When appropriate:** Medium-to-large teams on Kubernetes, audit requirements, multi-environment.

**Pros:** Full audit trail (every deploy = commit), rollback = `git revert`, self-healing, declarative.

**Cons:** Requires Kubernetes, learning curve, reconciliation lag (30-60s), bootstrapping secrets is complex.

**Tools:** ArgoCD, Flux v2, Weave GitOps, Crossplane

---

## Self-Hosted PaaS: The 2024-2025 Trend

The most relevant category for small teams on a VPS.

---

### Kamal 2 (from 37signals/DHH)

The most significant entrant in this space. Built for deploying Basecamp/Hey to bare metal.

**How it works:** Docker for packaging, SSH for deployment — no daemon on the server, no Kubernetes. Coordinated from local machine or CI runner.

**Key features:**
- `kamal setup` — first deploy, installs Docker
- `kamal deploy` — build image, push, rolling deploy with health checks
- `kamal rollback` — revert to previous image
- **Kamal Proxy** (new in v2) — purpose-built Go proxy replacing Traefik, handles zero-downtime atomic swap
- Multi-server via YAML config

```yaml
service: myapp
image: ghcr.io/myorg/myapp
servers:
  web: [1.2.3.4]
proxy:
  ssl: true
  host: myapp.com
  healthcheck: { path: /health }
accessories:
  db:
    image: postgres:16
    volumes: ["/data/postgres:/var/lib/postgresql/data"]
```

**Verdict:** Best default for 1-5 person teams on a VPS in 2025. Threads the needle between docker-compose chaos and Kubernetes complexity. Ruby CLI dependency is the main friction.

---

### Coolify

Open-source Heroku/Netlify alternative with a web UI. Installs on your server, connects to Git repos, builds via Nixpacks/Docker, deploys behind Traefik.

**Pros:** Beautiful UI, one-click databases, PR preview environments, free.

**Cons:** Coolify itself is a complex stateful service to maintain. UI-first means less reproducible than code-as-config.

---

### Dokku

The original self-hosted Heroku (2013). `git push dokku main` → buildpack detection → deploy with Nginx upstream swap.

**Pros:** Closest to Heroku UX, mature (10+ years), plugin ecosystem.

**Cons:** Builds on server (slow), single-server only, less active development.

---

## Universal Best Practices

### Zero-Downtime Deploys

Three approaches:
1. **Rolling with health gate:** Start new → wait for `/health` 200 → swap upstream → drain old → stop old. (Kamal, k8s)
2. **Blue-green:** Two environments, flip load balancer after smoke tests. Clean but expensive (2x resources).
3. **Canary:** Route 5% to new version, monitor, ramp gradually. Requires traffic-splitting proxy.

For single-server: rolling with health gate is the pragmatic choice.

### Rollback Strategies

- **Application rollback:** trivial with image tags or symlinks
- **Database rollback:** the hard part. Solution: **expand-contract migrations** — only add columns/tables; never drop in same deploy as code change. Keep schema compatible with N-1 app version.

### Secret Management (levels of sophistication)

1. `.env` on server — simple, unencrypted on disk
2. CI/CD env vars (GitHub Actions secrets) — injected at deploy time
3. Doppler / 1Password CLI — synced vault → environment
4. SOPS + age — encrypted in Git, decrypted at deploy
5. HashiCorp Vault — dynamic secrets, TTLs, audit (enterprise)
6. Cloud KMS + Secrets Manager — managed with IAM (AWS/GCP)

**Rules:** Never commit plaintext. Rotate on offboarding. Different secrets per environment.

### Health Checks

```
GET /health  → 200 (liveness: am I running?)
GET /ready   → 200 (readiness: am I ready for traffic?)
```

Check DB connectivity, critical dependencies. Keep fast (<100ms).

### Infrastructure as Code

- **Terraform/OpenTofu:** Declarative cloud provisioning. Hetzner has a mature provider.
- **Pulumi:** Same concept, real programming languages (TS, Python, Go).

For single server: IaC is optional but document setup as a script at minimum.

### Observability

**Logging:** Structured JSON, include request_id for correlation. Single VPS: journald is sufficient. Multi-service: Grafana Loki or hosted (BetterStack).

**Metrics:** Prometheus + Grafana (or Grafana Cloud free tier). Expose `/metrics` from Go gateway via `prometheus/client_golang`.

**Alerting:** UptimeRobot for external HTTP checks (free). Alert on: 5xx spike, P95 latency, disk >80%, cert expiry <30d, health check failing.

---

## What People Actually Use (2025-2026, small teams)

The dominant pattern for 1-5 person technical team:

```
GitHub Actions → build Docker image → push to GHCR → Kamal deploy (or SSH + docker compose pull)
```

Split:
- **Raw docker-compose:** ~40% — "good enough"
- **Kamal 2:** rapidly growing, especially Rails/Ruby spreading to Go/Node
- **Coolify:** teams wanting a UI
- **Managed PaaS (Railway/Render/Fly):** early startups, migrated away when bills hit $200-500/mo
- **Kubernetes:** rare under 10 engineers

---

## Decision Tree

```
Need >3 servers or auto-scaling?
  → YES: Managed k8s or Nomad
  → NO ↓

Want managed infra (no sysadmin)?
  → YES: Railway / Fly.io / Render
  → NO: Self-host ↓

Want a web UI?
  → YES: Coolify
  → NO ↓

Want git-push deploys without Dockerfiles?
  → YES: Dokku
  → NO ↓

Default (2025): Kamal 2 + GHCR + GitHub Actions
  + Caddy if separate proxy needed (Kamal Proxy handles HTTPS natively)
  + Grafana Cloud free tier for observability
```

---

## Comparison Matrix

| Approach | Complexity | Team Size | Cost | Zero-Downtime | Rollback | IaC |
|---|---|---|---|---|---|---|
| Manual SSH | Minimal | 1 | Free | No | Manual | No |
| rsync + scripts | Low | 1-2 | Free | With effort | Symlinks | Shell |
| Ansible | Medium | 2-10 | Free | With effort | Re-run old | Playbooks |
| Docker Compose | Low-Medium | 1-5 | Free | With effort | Image tags | YAML |
| **Kamal 2** | **Low** | **1-10** | **Free** | **Built-in** | **Built-in** | **Yes** |
| Coolify | Low (UI) | 1-10 | Free | Built-in | Via UI | Partial |
| Dokku | Low | 1-5 | Free | Built-in | Via CLI | Partial |
| Kubernetes | Very High | 10+ | $200+/mo | Built-in | Built-in | Helm |
| GitOps | High | 10+ | +k8s | Built-in | git revert | Full |
| PaaS | Minimal | Any | $20-500+/mo | Built-in | Dashboard | Partial |

---

## Relevance to equin/equin

Our stack: Go gateway + Bun/TS server + Vite SPA + PostgreSQL → Hetzner VPS + Caddy.

**What we already have that's Kamal-like:**
- `./equin build` — local build + restart
- Gateway doing subdomain routing to worktree backends via Unix sockets
- Health probes in the CLI

**What to adopt:**
1. **Structured logging** — JSON from both Go and Bun; request_id correlation
2. **Health check standardization** — `/health` on gateway + server
3. **SOPS + age** — encrypted secrets in repo, decrypted at deploy
4. **Postgres backup cron** — daily pg_dump to Hetzner Object Storage
5. **UptimeRobot + Grafana Cloud free tier** — baseline monitoring
6. **Zero-downtime gateway restart** — SO_REUSEPORT or SIGHUP reload
7. **`./equin deploy`** — extend CLI for remote deployment (Kamal-inspired, no Ruby dep)
