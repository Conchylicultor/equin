# equin.ai — End-to-End Deployment Roadmap

## Context

Singularity will be publicly branded as **equin** (domain: equin.ai). The goal is to deploy a stripped-down, read-only version of the app at equin.ai — serving a blog, download page, and a read-only interactive demo — while building the infrastructure and tooling that will eventually support automated deployments, updates, and future equin products.

This is the foundational deployment story: every future equin product is a Singularity **profile** (a named subset of plugins + config), built from the same codebase and deployed the same way.

---

## Step 1 — Infrastructure

> Setup tracker: [2026-05-05-equin-ai-infra-setup.md](./2026-05-05-equin-ai-infra-setup.md)

**Goal:** A live Linux server reachable at equin.ai and *.equin.ai.

- [ ] Provision a Hetzner CX32 (4 vCPU, 8GB RAM, ~€9/mo), Ubuntu 24.04 LTS
- [ ] Put Cloudflare in front (free tier): DNS + DDoS protection + CDN for static assets
- [ ] DNS records in Cloudflare:
  - `A equin.ai → <server IP>`
  - `A *.equin.ai → <server IP>` (wildcard, needed for subdomain routing)
- [ ] Install **Caddy** as reverse proxy
  - Handles TLS termination (Let's Encrypt wildcard cert via Cloudflare DNS challenge)
  - Forwards `*.equin.ai` traffic to the Go gateway on a local port
- [ ] **Decision:** Managed Postgres (Hetzner, ~€10/mo, simpler ops) vs self-hosted on same box (cheaper, more to manage)
- [ ] Set up SSH key auth, disable password login, firewall (ports 22, 80, 443 only)
- [ ] Set up Hetzner volume snapshots + daily DB dump to object storage (Hetzner S3 or Backblaze B2)

---

## Step 2 — Gateway Adaptation

**Goal:** The Go gateway supports real domains, not just `*.localhost`.

The gateway today hardcodes `.localhost` in `parseWorktree()` (`gateway/proxy.go`). The build CLI hardcodes `localhost:9000` health probe URLs (`cli/src/commands/build.ts`).

- [ ] Add `-base-domain` flag to `Config` in `gateway/main.go` (default: `"localhost"`)
- [ ] Update `parseWorktree()` in `gateway/proxy.go` to accept `*.<base-domain>` in addition to (or instead of) `*.localhost`
- [ ] Make the CLI health probe URLs configurable (env var or derived from a `SINGULARITY_BASE_DOMAIN` env) in `cli/src/commands/build.ts`
- [ ] **Decision:** Does the gateway serve on `:9000` behind Caddy, or does it terminate TLS itself?
  - Recommended: keep TLS at Caddy, gateway stays plain HTTP on a local port
- [ ] Update `cli/src/commands/start.ts` to print the correct URL based on base domain

---

## Step 3 — Profile / Export System

**Goal:** `./equin build --profile equin-ai` produces a deployable bundle with only the selected plugins.

This is the foundational primitive for equin as a product platform. Every equin product is a profile.

### Profile definition

- [ ] Define what a profile is: a TS file in `profiles/` listing included plugins + config overrides
  - **Decision:** plugin exclusion at build time (tree-shaken, smaller bundle) vs runtime capability flags (simpler but larger bundle) vs hybrid
- [ ] `profiles/equin-ai.ts` — blog, download, read-only demo subset; no prompt input, no push, no agent management
- [ ] `profiles/singularity.ts` — full agent manager (current default, no change to existing behavior)

### Build system changes

- [ ] `--profile <name>` flag on `./equin build`
  - Selects which `web/src/plugins.<profile>.ts` registry to use for the Vite build
  - Sets `VITE_MODE` / `VITE_PROFILE` env for frontend
  - Sets `SINGULARITY_PROFILE` env for the backend (passed via `Spec.Env` to the spawned process)
- [ ] Extend `Spec` struct in `gateway/worktree.go` to include `Env map[string]string` — lets the gateway inject profile-specific env vars when spawning the backend

### Plugin read-only awareness

- [ ] **Decision:** How do plugins express read-only behavior?
  - Option A: mutating sub-plugins simply excluded from the profile (no bundle = no UI)
  - Option B: global `capabilities` context (e.g. `canWrite: false`) that plugins read to hide controls
  - Option A is cleaner and enforced at build time; Option B is easier to implement incrementally
- [ ] For the equin-ai profile, excluded plugins would include: `prompt-input`, `push-and-exit`, `fork-conversation`, `fork-session`, `drop-and-exit`, `hold-and-exit`, `new-child-task`, `task-draft-form`, all agent-launch actions

### Shell

- [ ] **Decision:** Does equin.ai use the existing `shell` plugin layout (sidebar + toolbar) or a new marketing shell (header nav, footer, landing sections)?
  - The demo section of equin.ai may embed the existing shell; the blog/download pages need a different layout
  - Could be a separate shell plugin contributed by the equin-ai profile

---

## Step 4 — The equin.ai App

**Goal:** The actual content and UX of equin.ai.

### Blog

- [ ] **Decision:** Static site generator (Astro, Next.js static export) vs Singularity plugin serving MDX
  - Static is simpler and Cloudflare-cacheable; plugin approach keeps everything in one deploy
- [ ] Content: announcement post, vision, changelog

### Download page

- [ ] Static HTML page with platform-specific download buttons
- [ ] Binaries hosted on **GitHub Releases** or **Cloudflare R2** — never served from the origin server
- [ ] Version detection: latest release from GitHub API or a static `version.json` written at release time

### Read-only demo

- [ ] Pre-seeded Postgres snapshot with interesting fake tasks, conversations, JSONL logs
- [ ] All `POST`/`PATCH`/`DELETE` routes return `403` (guarded by `SINGULARITY_PROFILE=equin-ai` env check on the server)
- [ ] WebSocket `/ws/notifications` still runs (broadcasts only, no mutations)
- [ ] **Decision:** How realistic/live does the demo feel?
  - Option A: fully static fixture data, no server calls
  - Option B: live read-only server with pre-seeded DB (more realistic, slightly more infra)

---

## Step 5 — Deployment Pipeline

**Goal:** Pushing to `main` automatically deploys to equin.ai with zero downtime.

### Trigger

- [ ] **Decision:** Branch-based (`release` tag or `main` push with `[deploy]` label) vs always-on (every push to `main` deploys)

### CI

- [ ] GitHub Actions workflow:
  - `./equin build --profile equin-ai` (or equivalent build command)
  - Run checks (`./equin check`)
  - Package artifact
- [ ] **Decision:** Docker container vs tarball + rsync to server
  - Docker: portable, reproducible, blue-green swap is easy
  - Rsync: simpler, no registry needed, works well for a single server

### Delivery & zero-downtime restart

- [ ] Push artifact to server (rsync or Docker push to registry)
- [ ] **Decision:** Restart strategy:
  - `systemd` rolling restart (simple, ~1s downtime)
  - Blue-green swap (two gateway instances, swap at load balancer level — zero downtime)
  - For a marketing site, systemd restart is acceptable initially
- [ ] systemd units for: gateway, equin-ai backend

### Secrets / env

- [ ] Server secrets (DB URL, profile config) injected via systemd `EnvironmentFile`, not baked into the artifact
- [ ] GitHub Actions secrets for SSH deploy key

---

## Step 6 — Ongoing Operations

**Goal:** The server runs reliably and issues surface quickly.

- [ ] **Uptime monitoring:** Uptime Kuma (self-hosted) or Better Uptime — alert on equin.ai going down
- [ ] **Error monitoring:** Sentry (free tier) or self-hosted Glitchtip — frontend JS errors + server exceptions
- [ ] **Backups:**
  - Daily Postgres dump to object storage (cron + `pg_dump`)
  - Hetzner volume snapshot weekly
- [ ] **Log aggregation:** stdout/stderr → systemd journal, `journalctl` for debugging (sufficient at this scale)
- [ ] **Metrics:** Optional — Prometheus + Grafana or Hetzner's built-in server metrics for CPU/memory/disk alerts

---

## Open Decisions Summary

| # | Decision | Options |
|---|---|---|
| 1 | Managed vs self-hosted Postgres | Hetzner managed (~€10/mo) vs on-box |
| 2 | Gateway TLS | Caddy terminates (recommended) vs gateway handles TLS itself |
| 3 | Profile: plugin exclusion vs capability flags | Build-time exclusion (cleaner) vs runtime flags (incremental) |
| 4 | equin.ai shell | Extend existing shell vs new marketing shell plugin |
| 5 | Blog approach | Static SSG vs Singularity plugin |
| 6 | Demo data | Static fixtures vs live read-only Postgres |
| 7 | CI artifact format | Docker vs rsync tarball |
| 8 | Deploy trigger | Every main push vs explicit release tag |
| 9 | Restart strategy | systemd restart (~1s downtime) vs blue-green (zero downtime) |

---

## Execution Order

Steps have dependencies; the recommended sequence:

```
1. Infrastructure        ← unblocks everything, no design deps
2. Gateway adaptation    ← needed before any real-domain deploy
3. Profile system        ← needed before equin.ai app has its own identity
4. equin.ai app          ← content + read-only demo (can start in parallel with 3)
5. Deployment pipeline   ← automates what was done manually in steps 1-4
6. Operations            ← can be layered in throughout, finalized after deploy
```

Steps 3 and 4 can proceed in parallel once Step 2 is done.
