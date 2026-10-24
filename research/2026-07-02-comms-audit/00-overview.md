# Communications Audit — Overview & Mental Model

> Full audit of every DB ↔ Server ↔ Client communication path in equin:
> the raw pieces, the abstractions layered on top, how they connect, and the
> public APIs with real consumer examples.
>
> This is the index + mental-model document. Each area has its own deep-dive:
>
> | File | Covers |
> |---|---|
> | [01-topology-and-transport.md](./01-topology-and-transport.md) | Processes, gateway, Unix sockets, central runtime, ports |
> | [02-database-layer.md](./02-database-layer.md) | Embedded Postgres, PgBouncer, pools, migrations, forks, change-feed triggers, derived state |
> | [03-http-endpoints.md](./03-http-endpoints.md) | Typed request/response: `defineEndpoint`, codecs, NDJSON streams, health, attachments, MCP |
> | [04-live-state.md](./04-live-state.md) | The push pipeline: resources, WS protocol, keyed deltas, the L1–L4 layers, leader election, optimistic mutations |
> | [05-boot-and-hydration.md](./05-boot-and-hydration.md) | Client boot: eager/deferred plugin tiers, boot-snapshot, config hydration, stale-bundle detection |
> | [06-jobs-and-events.md](./06-jobs-and-events.md) | Background lane: graphile-worker jobs, trigger events, watchers, queue health |
> | [07-side-channels.md](./07-side-channels.md) | Log channels, terminal PTY, conversation transcript spine, reports/crash pipeline, auth/secrets/central, Zero pilot |
> | [08-api-catalog.md](./08-api-catalog.md) | One-page catalog: every communication API, when to use which, consumer index |

---

## 1. The one-paragraph summary

equin has **one sanctioned way to do each kind of communication**, and
checks/lints that ban hand-rolled alternatives. Reads that must stay fresh go
through **live-state resources** (server-computed values pushed over a shared,
leader-elected WebSocket). One-shot reads and writes go through **typed
endpoints** (zod-validated HTTP contracts). Server-to-server change detection
goes through **Postgres itself** (statement triggers → `pg_notify` → LISTEN),
so no write can ever be missed — even writes made by `psql` from outside the
process. Recurring/background work goes through **durable jobs**
(graphile-worker) bound to **typed events**, never `setInterval`. Everything
rides through a **Go gateway** on port 9000 that routes by subdomain to
per-worktree Bun backends over Unix domain sockets.

## 2. Process topology (who talks to whom)

```
                    ┌────────────────────────────────────────────────────────┐
                    │  Browser (N tabs, one origin per worktree subdomain)   │
                    │                                                        │
                    │  follower tabs ──BroadcastChannel──▶ leader tab        │
                    │  (Web Locks election; only the leader owns sockets)    │
                    └───────────────┬────────────────────────────────────────┘
                     HTTP /api/*    │  WS /ws/notifications, /ws/logs, /ws/terminal
                     static assets  │  (all on <name>.localhost:9000)
                                    ▼
                    ┌────────────────────────────────────────────────────────┐
                    │  Gateway (Go, :9000) — the only TCP listener           │
                    │  • subdomain → worktree routing                        │
                    │  • central-routes.json → central backend (any host)    │
                    │  • /zero/* → zero-cache sidecar (loopback TCP)         │
                    │  • static file serving from web/dist                   │
                    │  • supervises: Postgres, PgBouncer, backends, zero     │
                    └──────┬─────────────────┬──────────────────┬────────────┘
                Unix socket│        Unix sock│           TCP    │
                           ▼                 ▼                  ▼
                ┌──────────────────┐ ┌───────────────┐ ┌────────────────┐
                │ worktree backend │ │ central backend│ │ zero-cache     │
                │ (Bun, 1/worktree)│ │ (Bun, 1/user)  │ │ (Node, pilot)  │
                │ no TCP listener  │ │ auth, secrets  │ │ PG→SQLite repl │
                └───┬──────────┬───┘ └───────────────┘ └────────┬───────┘
        app queries │          │ LISTEN, jobs, admin            │ logical
        (pooled)    ▼          ▼ (direct)                       │ replication
                ┌──────────┐ ┌─────────────────────┐            │
                │ PgBouncer │ │ Postgres 18 :5433   │◀───────────┘
                │  :6432    │▶│ (embedded, 1 cluster,│
                │ txn mode  │ │  1 DB per worktree)  │
                └──────────┘ └─────────────────────┘
```

Key facts:

- **Backends have no TCP port.** The gateway hands each one a Unix socket
  (`~/.singularity/sockets/<name>.sock`) and dials it directly, for both HTTP
  and hand-rolled WebSocket byte-shuttling. Zero port allocation problems.
- **One Postgres cluster, many databases.** Every worktree gets a full fork of
  the main `singularity` DB (data + migration state), named after its attempt
  id. Isolation is per-database, not per-cluster.
- **Two connection paths to Postgres.** App queries go through PgBouncer
  (transaction pooling, port 6432). Anything session-bound — `LISTEN`,
  graphile-worker, logical replication, `pg_dump` — goes direct to 5433.
- **The central backend is a second, singleton Bun process** hosting state
  that must be shared across all worktrees (OAuth tokens, secrets). Browsers
  reach it via path-prefix routes (`~/.singularity/central-routes.json`) that
  work on *any* host — required for OAuth callbacks on bare `localhost`.

## 3. The three communication idioms (client ↔ server)

Every client↔server interaction in the codebase is one of exactly three
shapes. Picking the right one is the main design decision; the wrong one is
usually caught by a check.

### Idiom A — Typed request/response (`endpoints`)

For **actions** (mutations) and **one-shot reads** that don't need to stay
fresh. A contract declared once in `core/endpoints.ts` with `defineEndpoint`,
implemented server-side with `implement()`, consumed with
`useEndpoint`/`useEndpointMutation`/`fetchEndpoint`. Zod validation at both
ends, `HttpError`/`EndpointError` as the error model. Raw `fetch("/api/…")`
from web code is banned by lint.

### Idiom B — Level-state sync (`live-state` resources)

For **anything the UI wants kept in sync with server truth**. A resource is a
named, schema'd server-side loader (`defineResource`); the client subscribes
with `useResource` and receives *level state* (full values or keyed row
deltas — never event streams the client must fold). The server decides when
to recompute (triggered by the DB change-feed, not by mutation code), diffs,
and pushes over the shared `/ws/notifications` socket. Hand-rolled SSE or WS
for state sync is banned by check.

### Idiom C — Append-only firehoses (dedicated WS / NDJSON)

For streams that are genuinely append-only and unbounded: terminal PTY bytes
(`/ws/terminal`), live log tailing (`/ws/logs`), progressive results of a
heavy fan-out (NDJSON streaming responses). These are the sanctioned
exceptions to "everything is a resource" — level-state semantics don't fit a
byte stream.

**Rule of thumb the codebase follows:** if a component would need `useEffect`
+ refetch to stay correct, it should be a resource (Idiom B). If it's a
button click or a form submit, it's an endpoint (Idiom A). If it scrolls
forever, it's a firehose (Idiom C).

## 4. The server-side data flow (DB → client), end to end

The load-bearing pipeline — what happens when *any* row changes in Postgres:

```
  INSERT/UPDATE/DELETE on any public table (from anywhere: handler, job, psql)
      │
      ▼  [L4 — change-feed]  STATEMENT trigger on every table
  live_state_notify()  ──┬──▶  pg_notify('live_state', {t, op, ids})     (live path)
                         └──▶  INSERT live_state_changelog (xid, t, op, ids)  (durable outbox,
      │                                                     same transaction — atomic)
      ▼
  change-feed LISTEN consumer (dedicated non-pooled connection)
      │  routeChange(): base table + every dependent view
      ▼
  applyDbChange()  — inverts the table→resources index
      │     • index fed by [L3 — read-set capture]: every SQL query a loader
      │       runs is recorded against that loader automatically
      │     • scope decision: UPDATE with ids + covered path → scoped;
      │       INSERT/DELETE/unknown → FULL recompute for that resource
      ▼
  scheduleNotify → flush cycle over the dependsOn DAG (level-parallel,
      │            affectedMap translates row ids across edges,
      │            signature gates suppress irrelevant cascades)
      ▼
  loader recompute (possibly scoped to affected ids)
      │     • keyed resources: diff vs per-subscriber snapshot → upserts/deletes  [L1]
      │     • boot-critical resources: value + xmin watermark + read-set
      │       persisted to live_state_snapshot  [L2]
      ▼
  WS frame to every subscribed tab:  update | delta | invalidate
      │
      ▼
  leader tab NotificationsClient → TanStack Query cache → React re-render
  (followers receive the same frame via BroadcastChannel relay)
```

The four numbered layers (terminology used literally in code and research
docs):

- **L1 — keyed delta sync**: array resources with a `keyOf` ship row-level
  upserts/deletes instead of the whole array; unchanged rows keep object
  identity so memoized rows skip re-render.
- **L2 — persisted materialization**: boot-critical resource values are
  persisted (with an xmin watermark and their read-set) so a cold server boot
  serves them instantly and replays only the changelog rows it missed.
- **L3 — read-set capture**: the DB pool chokepoint records which tables each
  loader actually reads. No manual dependency declarations for the common
  case; the debug pane diffs this truth against the hand-drawn graph.
- **L4 — DB change-feed**: the Postgres triggers + LISTEN/NOTIFY above. Its
  design goal: *missed invalidations are structurally impossible*, because
  invalidation is driven by the database itself, not by remembering to call
  `notify()` in every mutation path.

Because of L4, a DB-backed resource **has no `.notify()` method at all** —
only `defineExternalResource` (for non-DB sources like files or git) gets
one. Forgetting to invalidate is a compile-time impossibility, not a bug
class.

## 5. Where the primitives live (plugin tree)

```
plugins/
├── framework/plugins/
│   ├── server-core/       # Bun server: route tables, WS upgrade, boot phases,
│   │                      #   defineResource facade, /ws/notifications wiring
│   ├── central-core/      # same facade for the central process (/ws/central-notifications)
│   ├── resource-runtime/  # THE live-state engine (shared by both facades):
│   │                      #   dependsOn DAG, flush cycle, keyed diffs, applyDbChange
│   ├── web-sdk/           # slots/contributions, plugin loader, eager/deferred tiers
│   └── web-core/          # index.html, main.tsx, App.tsx (the boot sequencer)
├── primitives/plugins/
│   ├── networking/        # SharedWebSocket, CrossTabElection (Web Locks + BroadcastChannel),
│   │                      #   ReconnectingEventSource, useReconnectingWebSocket,
│   │                      #   fetchWithRetry, ws-status-bus, net-diag-bus
│   ├── live-state/        # client half: ResourceDescriptor, useResource,
│   │                      #   NotificationsClient, keyed delta merge, hydrateResource
│   ├── optimistic-mutation/ # useOptimisticResource (overlay/replay on server truth)
│   ├── log-channels/      # clientLog → JSONL files; /api/logs/*, /ws/logs
│   ├── terminal/          # /ws/terminal + bun-pty sessions
│   └── perfs/plugins/     # boot-trace store, yieldToMain scheduler
├── infra/plugins/
│   ├── endpoints/         # defineEndpoint / implement / fetchEndpoint / useEndpoint
│   ├── ndjson-stream/     # ndjsonResponse (server) + readNdjson (client)
│   ├── boot-snapshot/     # one-request pre-paint hydration of boot-critical resources
│   ├── health/            # /api/health, /api/health/ready (gateway hot-swap gate)
│   ├── jobs/              # defineJob on graphile-worker (durable, cron, ctx.step/waitFor)
│   ├── events/            # defineTriggerEvent + trigger() event→job bindings
│   ├── git-watcher/       # git refs → refAdvanced event + refHead resource
│   ├── file-watcher/      # shared @parcel/watcher primitive (debounce/ceiling/reconcile)
│   ├── mcp/               # POST /api/mcp/:conversationId, Mcp.tool registry
│   ├── attachments/       # multipart upload + on-disk store + link tables
│   ├── secrets/           # encrypted KV on central (AES-256-GCM + OS keychain)
│   ├── runtime-profiler/  # span recorder; the L3 read-set capture lives here
│   └── worktree/          # worktree specs the gateway reads
├── database/plugins/
│   ├── embedded/          # Postgres 18 binaries + lifecycle script (gateway-run)
│   ├── pgbouncer/         # pooler config + lifecycle script (gateway-run)
│   ├── migrations/        # hash-ledger migration runner + dry-run check
│   ├── admin/             # adminPool, forkDatabase, drop/list/ensure
│   ├── fork/              # durable per-worktree fork job + temp sweep
│   ├── change-feed/       # L4: triggers, LISTEN consumer, routeChange
│   ├── live-state-snapshot/ # L2: snapshot table, watermark, catch-up
│   ├── derived-tables/    # trigger-maintained rollups (hand-rolled IVM)
│   ├── derived-views/     # boot-rebuilt plain views
│   └── zero/              # Rocicorp Zero pilot (cache-service + client adapter)
├── auth/                  # OAuth on the central runtime; authStateResource
└── gateway/               # (not a plugin — Go) the :9000 proxy + supervisor
```

## 6. The design principles that explain everything else

1. **Level state, not event streams.** Clients receive *values* (or value
   deltas), never domain events they must fold into state. This kills the
   whole "missed event while reconnecting" bug class: reconnect = resubscribe
   = fresh value.
2. **The database is the change bus.** Mutation code never signals
   invalidation; the write itself does, via triggers. Out-of-process writes
   (another worktree, `psql`, a job) are invalidation-equivalent to in-process
   ones.
3. **One socket per origin, one computation per change.** Leader election
   means N tabs cost one WebSocket and one server-side recompute; followers
   get frames relayed over BroadcastChannel.
4. **Contracts are single-sourced.** Endpoint route strings double as route
   keys; resource descriptors carry key + schema + keyed-ness so server and
   client structurally cannot drift; entity tables and wire schemas derive
   from one field record.
5. **Durability at every async boundary.** Jobs are graphile rows (survive
   restarts), the change-feed has a durable outbox (survives downtime),
   emitted events are durable dispatch jobs, boot catch-up replays the
   changelog. In-process timers and fire-and-forget are the exception and
   must be justified.
6. **Escape hatches are visible.** FULL recomputes, feed exemptions,
   unbounded waits, polling fallbacks all require an explicit, greppable
   opt-out with a reason — and debug surfaces (read-set pane, `_debug`
   endpoint, queue-health, churn monitors) measure how often the escape
   hatches fire.
