# Self-Hosted Deployment Platform

## Context

All deployment operations today happen via CLI and SSH — provisioning the Hetzner server, bootstrapping it, deploying code, checking health, tailing logs. The goal is to bring all of this into the equin UI as a first-class plugin, so that the full lifecycle of a remote server is managed from the same surface where agents work.

This is the "Coolify built into equin" idea: a deployment dashboard that knows about our stack (Go gateway + Bun server + Vite SPA + Postgres) and can manage the full deploy lifecycle for equin.ai and future products.

Reference docs:
- [Infra setup status](./2026-05-05-equin-ai-infra-setup.md) — Hetzner server details, bootstrap plan
- [Deployment landscape](./2026-05-05-deployment-landscape.md) — Industry survey, Kamal/Coolify comparison
- [Deployment roadmap](./2026-05-04-global-equin-ai-deployment-roadmap.md) — 6-step plan from infra to operations

---

## What the Plugin Does

An umbrella plugin at `plugins/deploy/` that gives you a sidebar section called **Deploy**. Click it and you see your managed servers. Click a server and you see its full status: is it healthy, what's deployed, what are the recent logs, can I deploy new code to it.

### The five concerns (each a sub-plugin)

**1. Servers** (`plugins/deploy/plugins/servers/`)
The foundation. A CRUD registry of remote servers you manage. Each server has: name, host/IP, SSH port, SSH user. The SSH private key is stored encrypted via the secrets primitive (never in the DB). This is the only plugin that knows how to create an SSH connection — every other sub-plugin imports the `createSshConnection()` factory from here.

*UI: Server list in the sidebar → server detail pane with status badge.*

**2. Health** (`plugins/deploy/plugins/health/`)
Periodic monitoring. Every 60 seconds, probes each registered server with an SSH connectivity check and an HTTP health endpoint check. Stores results with latency. Updates the server's status badge (online/offline/unknown). History is kept for debugging flaky connections.

*UI: Health status chips on the server detail pane — green/red for SSH and HTTP, with latency and last-checked time.*

**3. Pipeline** (`plugins/deploy/plugins/pipeline/`)
The deploy action. When you hit "Deploy", it runs a multi-step job: build the artifact locally, upload it to the server, restart services, verify health. Each step logs output in real-time. Keeps a deploy history so you can see what shipped when. Supports rollback to a previous version.

The actual deploy mechanism (rsync vs Docker vs git-pull) is a decision for later — the skeleton defines the job structure and UI without committing to a specific strategy.

*UI: Deploy history list + "Deploy Now" button on the server detail. Deploy detail pane with live log viewer.*

**4. Logs** (`plugins/deploy/plugins/logs/`)
Live server log tailing over SSH. Connects to the server, runs `journalctl -f`, and streams lines to the browser over WebSocket. Filter by systemd unit (gateway, server, caddy, etc.).

*UI: Log viewer pane with ANSI rendering, unit filter dropdown, auto-scroll.*

**5. Bootstrap** (`plugins/deploy/plugins/bootstrap/`)
One-time server setup automation. The bootstrap script (UFW firewall, SSH hardening, Postgres, Go, Bun, Caddy, directory structure) that today lives in the infra setup doc gets uploaded and executed remotely. Output streams to the UI in real-time. Tracks run history so you know if a server was bootstrapped and when.

*UI: "Run Bootstrap" button on the server detail, with a live output log viewer.*

---

## Plugin Architecture

```
plugins/deploy/
├── web/
│   ├── index.ts          # Shell.Sidebar entry, slot exports
│   └── slots.ts          # Deploy.Section slot (server detail sections)
├── server/
│   └── index.ts          # Umbrella descriptor (no routes)
│
└── plugins/
    ├── servers/
    │   ├── shared/index.ts      # Server type + Zod schema
    │   ├── web/                 # Server list pane, server detail pane
    │   │   ├── index.ts
    │   │   ├── panes.tsx
    │   │   └── components/
    │   └── server/              # CRUD routes, SSH factory, defineResource
    │       ├── index.ts
    │       └── internal/
    │           ├── tables.ts    # deploy_servers
    │           ├── ssh.ts       # createSshConnection()
    │           └── ...handlers
    │
    ├── health/
    │   ├── web/                 # Health section contribution
    │   │   ├── index.ts
    │   │   └── components/
    │   └── server/              # Health check job, probes, defineResource
    │       ├── index.ts
    │       └── internal/
    │           ├── tables.ts    # deploy_health_checks
    │           └── ...
    │
    ├── pipeline/
    │   ├── shared/index.ts      # Deploy type + Zod schema
    │   ├── web/                 # Deploy section, deploy detail pane
    │   │   ├── index.ts
    │   │   ├── panes.tsx
    │   │   └── components/
    │   └── server/              # Deploy job, rollback job, MCP tools
    │       ├── index.ts
    │       └── internal/
    │           ├── tables.ts    # deploy_deploys
    │           ├── events.ts    # deployCompleted trigger event
    │           └── ...
    │
    ├── logs/
    │   ├── web/                 # Logs section, full log viewer pane
    │   │   ├── index.ts
    │   │   ├── panes.tsx
    │   │   └── components/
    │   └── server/              # WS route: SSH → journalctl → browser
    │       ├── index.ts
    │       └── internal/
    │
    └── bootstrap/
        ├── web/                 # Bootstrap section, wizard pane
        │   ├── index.ts
        │   ├── panes.tsx
        │   └── components/
        └── server/              # Bootstrap job, script upload + exec
            ├── index.ts
            └── internal/
                ├── tables.ts    # deploy_bootstrap_runs
                └── bootstrap.sh # Idempotent Ubuntu 24.04 setup script
```

### Key primitives used

| Primitive | From | Used for |
|---|---|---|
| `defineResource` (push mode) | `@server/resources` | Live server list + health status → UI auto-updates |
| `resourceDescriptor` | `@plugins/primitives/plugins/live-state/shared` | Client-side resource binding |
| `defineJob` + `ctx.step` | `@plugins/infra/plugins/jobs/server` | Deploy, health check, bootstrap background jobs |
| `defineTriggerEvent` | `@plugins/infra/plugins/events/server` | `deployCompleted` event for future extensions |
| `Log.channel` | `@plugins/debug/plugins/logs/server` | Real-time log streaming during deploy/bootstrap |
| `setSecret` / `getSecret` | `@plugins/infra/plugins/secrets/server` | SSH private key storage |
| `Mcp.tool` | `@plugins/infra/plugins/mcp/server` | Agent-accessible deploy/health tools |
| `Pane.define` / `Pane.Register` | `@plugins/primitives/plugins/pane/web` | All pane definitions |
| `Shell.Sidebar` | `@plugins/shell/web` | Sidebar entry |
| `defineSlot` | `@core/slots` | `Deploy.Section` — server detail sections |

### Pane routes

```
/deploy                               → Server list (sidebar root)
/deploy/:serverId                     → Server detail (renders Deploy.Section slot)
/deploy/:serverId/deploys/:deployId   → Deploy log viewer
/deploy/:serverId/logs                → Live server logs
/deploy/:serverId/bootstrap           → Bootstrap wizard + log
```

### DB tables

**`deploy_servers`** — id, name, host, port, sshUser, status, createdAt, updatedAt
*(SSH key in secrets namespace `deploy-ssh`, keyed by serverId)*

**`deploy_health_checks`** — id, serverId (FK cascade), kind (http/ssh), status, latencyMs, error, checkedAt

**`deploy_deploys`** — id, serverId (FK cascade), version, status (queued/running/success/failed/rolled-back), log, error, startedAt, finishedAt, createdAt

**`deploy_bootstrap_runs`** — id, serverId (FK cascade), status, output, error, startedAt, finishedAt, createdAt

### API endpoints

```
# Servers
GET    /api/deploy/servers
POST   /api/deploy/servers
GET    /api/deploy/servers/:id
PATCH  /api/deploy/servers/:id
DELETE /api/deploy/servers/:id
POST   /api/deploy/servers/:id/ssh-key

# Health
GET    /api/deploy/servers/:id/health
GET    /api/deploy/servers/:id/health/history

# Pipeline
POST   /api/deploy/servers/:id/deploy
GET    /api/deploy/servers/:id/deploys
GET    /api/deploy/deploys/:id
POST   /api/deploy/deploys/:id/rollback

# Logs
WS     /ws/deploy/logs   (subscribe/unsubscribe by serverId + unit filter)

# Bootstrap
POST   /api/deploy/servers/:id/bootstrap
GET    /api/deploy/servers/:id/bootstrap
```

### MCP tools (for agents)

- `deploy_list_servers` — list all servers with health status
- `deploy_trigger_deploy` — trigger a deploy to a server
- `deploy_get_deploy_status` — get deploy status + log tail
- `deploy_get_server_health` — latest health check results
- `deploy_run_bootstrap` — run bootstrap on a server

---

## Implementation Plan (Skeleton)

Build the structural scaffold — plugin definitions, DB tables, pane shells, slot wiring — without SSH logic, actual deploy jobs, or real health probes. Each sub-plugin gets its full file tree but with stub/placeholder implementations.

### Phase 1: Umbrella + Servers (the foundation)

1. **Umbrella** — `plugins/deploy/web/index.ts`, `server/index.ts`, `slots.ts`
   - `Deploy.Section` slot definition
   - `Shell.Sidebar` contribution pointing to servers root pane

2. **Servers sub-plugin** — full CRUD scaffold
   - `deploy_servers` table
   - Server list pane + server detail pane (renders `Deploy.Section` contributions)
   - API routes (all functional — this is real CRUD, no SSH needed)
   - `serversResource` (push mode)
   - SSH key storage via secrets (store/delete, no connect yet)

### Phase 2: Health + Pipeline stubs

3. **Health** — table + section contribution + stub job
   - `deploy_health_checks` table
   - `Deploy.Section` contribution showing placeholder health status
   - `healthCheckJob` defined but with a stub `run` (logs "not implemented")

4. **Pipeline** — table + section contribution + deploy detail pane shell
   - `deploy_deploys` table
   - `Deploy.Section` contribution with deploy history list + disabled "Deploy Now" button
   - Deploy detail pane with empty log viewer
   - `deployCompleted` trigger event defined
   - MCP tool stubs (return "not yet implemented")

### Phase 3: Logs + Bootstrap stubs

5. **Logs** — section contribution + pane shell
   - `Deploy.Section` with "Logs coming soon" placeholder
   - Server logs pane shell (no WS handler yet)

6. **Bootstrap** — table + section contribution + pane shell
   - `deploy_bootstrap_runs` table
   - `Deploy.Section` with disabled "Run Bootstrap" button
   - Bootstrap pane shell

### Verification

After each phase:
```bash
./equin build
# Visit http://<worktree>.localhost:9000
# → Deploy sidebar entry visible
# → Can add/edit/delete servers
# → Server detail shows section stubs from sub-plugins
```

---

## What's NOT in this skeleton

- Actual SSH connections (`node-ssh` dependency, `createSshConnection` implementation)
- Real health probes (SSH ping, HTTP probe)
- Real deploy jobs (build, upload, restart, verify)
- Log streaming over WebSocket
- Bootstrap script content and execution
- The deploy mechanism decision (rsync vs Docker vs git-pull)

These are all follow-up work once the structure is validated.
