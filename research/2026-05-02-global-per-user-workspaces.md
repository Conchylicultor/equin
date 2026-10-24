# Per-user ephemeral workspaces — design exploration

**Status:** open questions, no decisions. This is a scoping doc, not a build plan.

## Context

We want to prepare equin for a multi-user future without retrofitting the app to be multi-tenant. The proposed model is **workspace-per-user**: each user gets their own isolated environment (container or microVM) running an unmodified single-tenant equin, with their own Postgres, filesystem, and `~/.singularity/`. Authentication is handled at an edge proxy (Cloudflare Access, oauth2-proxy, …) so equin itself never sees credentials — it just trusts an identity header from upstream. Cross-user data leaks become architecturally impossible because there is no shared DB or shared FS.

This doc enumerates the open infra/architectural questions and tradeoffs so an investigation agent can dig deeper and produce a recommendation.

## Reference architecture (sketch, not committed)

```
Browser ──► Edge proxy (TLS + auth) ──► Spawner ──► Per-user container/VM
   │              │                          │              ├── bun server
   │              │                          │              ├── go gateway
   │              │                          │              ├── postgres
   │              │                          │              ├── claude CLI + tmux
   │              │                          │              └── /data volume
```

Three replaceable layers: **edge** (auth), **spawner** (lifecycle/routing), **runtime** (per-user instance). Each has independent open questions.

## Open question 1 — Edge / auth layer

| Option | Pros | Cons |
|---|---|---|
| **Cloudflare Access** | Free ≤50 users, zero infra, Google/GitHub/email login, mature | $3/user/mo above free tier; ties identity to Cloudflare; requires CF-fronted DNS |
| **oauth2-proxy** (self-hosted) | Free at any scale, OIDC-flexible, runs in a sidecar container | Operational burden (sessions, secrets, upgrades) |
| **Authentik / Pocket-ID / Authelia** | Full self-hosted IdP, group/role policies, custom flows | Heavier; another service to run and back up |
| **Tailscale Funnel + tailnet identity** | Strong identity, free for personal | Users must install Tailscale; limits the "anyone with email" UX |

**Tradeoff axis:** ops burden vs vendor lock-in vs UX friction. CF Access is the path of least resistance for a beta; oauth2-proxy is the natural exit if/when CF tier becomes uncomfortable.

**Header contract to validate:** Cloudflare sets `Cf-Access-Authenticated-User-Email`; oauth2-proxy sets `X-Forwarded-Email` / `X-Forwarded-User`. Spawner + gateway need to trust exactly one upstream and reject requests missing the header.

## Open question 2 — Sandbox runtime

| Option | Isolation | Cold start | Cost shape | Notes |
|---|---|---|---|---|
| **Docker on a single VM** | Shared kernel; namespace + cgroup | 1–3 s | Fixed VM cost, ~free per idle user | Simplest; fine for 50–100 users on one big box |
| **Firecracker microVMs (Fly Machines)** | True kernel boundary; near-VM | 250 ms–2 s | Per-second machine billing; auto-stop on idle | Fly's `machines` API does spawning for you |
| **Full VM per user (Hetzner/EC2)** | Strongest | seconds–minutes | $5+/user/mo, always-on | Wasteful for idle users; overkill until mid-scale |
| **Nix containers / systemd-nspawn** | Same as Docker | similar | similar | Niche; only if we want declarative envs from day 1 |

**Tradeoff axis:** isolation strength vs cost-per-idle-user vs operational complexity. Docker wins for the first ~50 users; Fly Machines wins once we want sub-second cold start and don't want to babysit a host.

**Validation needed:**
- Does `claude` CLI work cleanly inside a container? (OAuth refresh on a headless host is the usual failure mode — likely need API-key fallback.)
- Does `tmux` behave correctly inside a non-init container? (PID 1 quirks.)
- Postgres-in-container on a bind-mounted volume — startup time, fsync behaviour, restore-from-snapshot story.

## Open question 3 — Hosting provider

| Provider | Best fit | $/16GB/mo (rough) |
|---|---|---|
| **Hetzner Cloud** | Cheap general-purpose VMs in EU | $35 |
| **Hetzner Dedicated** | Best $/perf if predictable load | $45 (64 GB) |
| **Fly.io** | If sandbox runtime = Fly Machines | metered, ~$45 for 5 active 4GB VMs |
| **DigitalOcean / Linode / Vultr** | US-presence, familiar UX | $48–80 |
| **Self-host (Mac Mini / NUC at home + Tailscale Funnel)** | Zero recurring infra | one-time hardware cost |

**Tradeoff axis:** $/RAM vs latency to user vs egress pricing vs jurisdictional concerns (GDPR for EU users). Hetzner is the strong default unless Fly's Machines API is the runtime.

## Open question 4 — Storage & persistence per user

- **Bind mount** (`/srv/singularity/<user_id>/data` → `/data`): simplest, host-FS-native, easy backups.
- **Docker named volume**: portable across hosts, harder to inspect.
- **Block-storage volumes** (Fly Volumes, EBS): required if running on Fly Machines; supports snapshots; one volume per user.

**Postgres siting:** in-container (one process per user, on their volume) vs shared cluster with one DB per user. In-container preserves the "leak architecturally impossible" property; shared cluster reintroduces a cross-user blast radius. **Default assumption: in-container Postgres.**

**Backup target:** Backblaze B2 (~$6/TB/mo) vs S3 vs Hetzner Storage Box. Per-user `restic` repo so a leak in the backup target doesn't cross-contaminate.

## Open question 5 — Spawner architecture (build vs adopt)

| Option | Pros | Cons |
|---|---|---|
| **Custom spawner** (~300 lines Go/Bun) | Tailored to our model; no extra concepts | We own it forever |
| **JupyterHub-style** (proxy + spawner separation) | Battle-tested pattern | Heavyweight; Python ecosystem |
| **Coder / Gitpod self-hosted** | Full workspace product | Massive surface; not designed for our stack |
| **Fly Machines API + thin router** | Spawner is just `fly machine start`; ~50 lines of router | Fly-locked |

**Tradeoff axis:** code we own vs lock-in vs scope creep. The custom spawner is small enough to be writeable in days; JupyterHub-style is overkill but informative.

**Open sub-questions:**
- Idle policy — stop after N minutes? Active conversation lock? Per-user override?
- Cold-start UX — full-page spinner? Stream progress over SSE?
- Health-check contract — what does "container ready" mean? (Postgres up + bun server responding?)
- Concurrent-session policy — same user from two browsers → same container, or reject?

## Open question 6 — Subdomain routing

The current model is `<worktree>.localhost:9000`. Per-user adds another dimension:

| Pattern | Pros | Cons |
|---|---|---|
| `<worktree>.<user>.singularity.app` | Mirrors local model, true per-worktree origin | Wildcard-of-wildcard TLS; CF Access scope rules get fiddly |
| `<user>.singularity.app/w/<worktree>/` | Single wildcard; simpler auth | Breaks per-worktree origin (cookies, CSP) |
| Per-user custom subdomain (`alice-sing.example.com`) | Clean | DNS plumbing per onboard |

**Validation needed:** does Cloudflare Access support wildcard-of-wildcard policy targeting? Does the current per-worktree origin assumption matter for security (cookie scoping)?

## Open question 7 — Code changes inside equin

Investigation in this worktree found ~7 modules independently call `homedir()`:

- `plugins/infra/plugins/secrets/central/internal/paths.ts:4`
- `plugins/infra/plugins/secrets/central/internal/store.ts:44` (redundant, should consume `paths.ts`)
- `plugins/infra/plugins/attachments/server/internal/paths.ts:1`
- `plugins/crashes/server/internal/buffer.ts:2`
- `plugins/conversations/server/internal/claude-transcript.ts:1` (uses `~/.claude`, not `~/.singularity`)
- `plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts:2` (same)
- `cli/src/commands/build.ts:5`, `cli/src/commands/start.ts:3`

**Gateway is already container-ready** — `gateway/main.go:43-49` accepts CLI flags for all paths.

**One hardcoded bug** to fix regardless of cloud work: `plugins/infra/plugins/claude-cli/server/internal/run-claude-print.ts:3` falls back to `/Users/admin/.local/bin/claude`.

**Identity injection point** is clear: `gateway/proxy.go:28-69` `Proxy.ServeHTTP`, after `parseWorktree`. The `central-routes.json` middleware pattern is a good template for adding identity-header trust.

**No app-user identity exists** (confirmed: `plugins/auth/` is for external OAuth, no `currentUser` concept anywhere). This *validates the workspace-per-user model* — we don't add user_id columns; we add a single `currentUserEmail` cosmetic surface (toolbar, git author).

**Estimated refactor scope:**
- Single `dataRoot()` helper consumed by all sites: ~1 day
- `SINGULARITY_DATA` / `SINGULARITY_CLAUDE_HOME` env vars + audit: ~1 day
- Read identity header in gateway, expose to bun server: ~1 day
- Fix `run-claude-print.ts` fallback: 5 min
- Dockerfile (bun + go gateway + postgres + claude CLI + tmux + git): ~1 day to first-boot, ~2 more to harden

## Open question 8 — Anthropic credentials per user

- **BYO API key** — simplest, user pays Anthropic directly, we never touch billing. Container reads `ANTHROPIC_API_KEY` from per-user secret injected by spawner.
- **Proxied through us** — we hold one key, meter per user, charge them. Requires hard per-user budget caps enforced *before* upstream call to avoid runaway-loop bankruptcy.
- **OAuth (Claude Max) per user** — appealing UX but Claude Max OAuth doesn't transfer cleanly to a server we don't own. Probably infeasible.

**Tradeoff axis:** business-model ambition vs operational risk vs onboarding friction.

## Open question 9 — Agent sandbox *within* a user's workspace

Separate concern from cross-user isolation. Today, a Claude agent running in a user's container can `rm -rf` that user's data. Cross-user leaks are still impossible, but self-harm isn't. Out of scope for v1 of this design, but flag for future: container-per-conversation *inside* the user's workspace, or seccomp/AppArmor profile on the bun process.

## Risks & unknowns to validate before committing

1. `claude` CLI auth lifecycle in a headless container — does the OAuth flow break? Need API-key fallback path tested end-to-end.
2. Postgres-per-user disk overhead — empirical data needed (a typical worktree DB size; multiply by N users).
3. Fly Machines cold-start latency in practice (advertised vs measured for our image size).
4. CF Access wildcard-of-wildcard TLS + policy support — confirm with a throwaway test domain.
5. tmux behaviour in a container without an init system (zombie reaping); may need `tini` or `docker run --init`.
6. Backup-restore drill on a per-user basis — does `restic` per user give us reasonable storage cost vs single shared repo?

## What an investigation agent should produce

A follow-up doc (`research/2026-MM-DD-global-per-user-workspaces-v2.md`) that:

1. **Resolves Q1 (edge)** with a concrete recommendation backed by a working hello-world (CF Access in front of a dummy bun container, identity header observed in request logs).
2. **Resolves Q2 (runtime)** with a working Dockerfile that boots equin end-to-end (bun server + go gateway + postgres + claude CLI + tmux), plus measured cold-start time for both Docker-on-Hetzner and Fly Machines.
3. **Resolves Q5 (spawner)** by sketching the spawner API (HTTP + state model), or pointing at a prior-art tool we should adopt.
4. **Confirms Q9 risks** — at minimum: claude CLI in container, postgres-on-volume restart, tmux init-quirks.
5. **Updates the path-refactor scope** with anything missed from the static survey above.
6. **Cost projection** at 5, 50, 500 users for the recommended runtime.
7. **Phased rollout plan** — solo (you) → trusted alpha (≤5 friends) → invite-only beta. With a clear "we can stop here" exit at each phase.

The investigation agent should *not* commit to any code changes — output is documents and disposable prototypes only.
