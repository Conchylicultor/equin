# 08 — API Catalog: Every Communication Primitive, With Consumers

> Part of the [communications audit](./00-overview.md). The one-page
> reference: what to reach for, from where, with real consumer examples.
> Deep-dives linked per row.

## 1. "I want to…" decision table

| I want to… | Use | Not |
|---|---|---|
| Read data that must stay fresh in the UI | `useResource(descriptor)` ([04](./04-live-state.md)) | polling `useEndpoint`, hand-rolled WS |
| Perform an action / one-shot read | `defineEndpoint` + `implement` + `useEndpointMutation`/`fetchEndpoint` ([03](./03-http-endpoints.md)) | raw `fetch` (lint-banned) |
| Make a mutation feel instant | `useOptimisticResource` overlay ([04](./04-live-state.md) §7) | writing predictions into the query cache |
| Publish server state not backed by the DB (file, git, memory) | `defineExternalResource` + `.notify()` | a DB-backed `defineResource` (has no notify — feed-driven) |
| React to a DB change server-side | nothing — the change-feed already invalidates resources; for *work*, bind a job to a domain event | LISTEN/NOTIFY of your own, timers |
| Announce a domain fact for unknown reactors | `defineTriggerEvent` + `emit()`; reactors bind `Trigger()`/`trigger()` ([06](./06-jobs-and-events.md)) | direct cross-plugin calls |
| Run durable/retryable/scheduled work | `defineJob` (+ `schedule.cron`; `ctx.step`/`waitFor` for workflows) | `setInterval`, fire-and-forget promises |
| Watch files / git | `createFileWatcher` / git-watcher's event+resource | raw `@parcel/watcher` (lint-banned), stat-polling |
| Stream unbounded output progressively | `ndjsonResponse` + `readNdjson`; dedicated WS for PTY/log tails | SSE (check-banned), buffering everything |
| Upload/serve files | `uploadAttachment` + `Attachments.defineLink` | ad-hoc disk writes |
| Log diagnostics that must survive wedges/restarts | `clientLog` / `Log.channel().publish` | console.log, live-state |
| Report an error/anomaly | a `defineReportSink` sink (web) / `recordReport` (server) | swallowing it (lint-banned) |
| Expose functionality to agents | `Mcp.tool` | bespoke CLI parsing |
| Share state across all worktrees | a central plugin + `centralResourceDescriptor` / secrets | per-worktree DB rows + fanout |

## 2. Catalog by primitive

### Transport & routing ([01](./01-topology-and-transport.md))

| API | Plugin | Consumers (examples) |
|---|---|---|
| Gateway subdomain routing, UDS proxying, WS hijack, `/gateway/*` | `gateway/` (Go) | every request; `./equin build` (restart POST) |
| `Bun.serve` route tables, `ServerPluginDefinition`, lifecycle hooks | `framework/server-core` | every server plugin |
| Central runtime + central-routes manifest | `framework/central-core`, cli build | auth, secrets |

### Database ([02](./02-database-layer.md))

| API | Plugin | Consumers (examples) |
|---|---|---|
| `db`, `pool` (pgbouncer path, loader gate) | `database` | every server plugin |
| `adminPool`, `openShortLivedClient`, `forkDatabase`, `dropDatabase` | `database/admin` | fork job, backup, query tool, zero sweep |
| `databaseForkJob` | `database/fork` | conversations (worktree creation) |
| migrations runner + `migration-applies-clean` | `database/migrations` | build/push pipeline |
| `ExcludeFromChangeFeed`, `live_state_changelog` | `database/change-feed` | high-churn observability tables |
| `View()` / `DerivedTable()` contributions | `database/derived-views` / `derived-tables` | conversations_v; conversations/agents rollup |
| `defineEntity` / `defineExtension` | `infra/entities` / `infra/entity-extensions` | slow_ops fixture; 16 ext side-tables (task-effort, starred…) |
| `query_db` MCP tool | `database/query` | agents (debugging) |

### Request/response ([03](./03-http-endpoints.md))

| API | Plugin | Consumers (examples) |
|---|---|---|
| `defineEndpoint`, `implement`, `HttpError`, codecs (`json`/`blob`/`multipart`) | `infra/endpoints` | 92 plugins |
| `fetchEndpoint`, `useEndpoint`, `useEndpointMutation`, `EndpointError` | `infra/endpoints/web` | everywhere client-side |
| `ndjsonResponse` / `readNdjson` | `infra/ndjson-stream` | worktree-cleanup audit, slow-ops cluster |
| `getHealth`, `waitForRestart`, `/api/health/ready` | `infra/health` | launcher; the gateway hot-swap gate |
| `uploadAttachment`, `Attachments.defineLink`, orphan sweep | `infra/attachments` | 17 plugins (conversations, tasks, pages, mail, paste-images…) |
| `Mcp.tool` | `infra/mcp` | add_task, query_db, get_queue_health, benchmark_boot, summaries |
| `SharedWebSocket`, `CrossTabElection`, `useReconnectingWebSocket`, `ReconnectingEventSource`, `fetchWithRetry`, status buses | `primitives/networking` | live-state, terminal, log viewers, health toast |

### Live-state ([04](./04-live-state.md))

| API | Plugin | Consumers (examples) |
|---|---|---|
| `resourceDescriptor` / `keyedResourceDescriptor` / `centralResourceDescriptor` | `primitives/live-state/core` | tasks-core (5 keyed), jsonl-events, auth state |
| `useResource` (+ `select`/`gate`), `hydrateResource`, `NotificationsProvider` | `primitives/live-state/web` | 100+ plugins |
| `defineResource` (two-arg descriptor form), `ScopePolicy`, `dependsOn`/`affectedMap`/`signature`, `debounceMs` | `server-core` facade over `resource-runtime` | tasks-core cascade; ~42 call sites |
| `defineExternalResource` (+ `revalidate`, sub lifecycle) | same | jsonl-events, refHead, frontendHash, op-status |
| `Resource.Declare({bootCritical})` | server-core contributions | tasks cluster, notifications, release, progress |
| `useOptimisticResource` | `primitives/optimistic-mutation` | config staging, conversation queue, page editor |
| `/api/resources/_debug`, read-set pane, churn monitors | server-core + debug plugins | live-state observability |

### Boot ([05](./05-boot-and-hydration.md))

| API | Plugin | Consumers (examples) |
|---|---|---|
| `Core.Boot` slot | `web-sdk` | boot-snapshot task, config task, tweakcn |
| boot-snapshot endpoint + hydration task | `infra/boot-snapshot` | all boot-critical resources |
| eager/deferred tiers (`DEFERRABLE_APPS`, `EAGER_EXCEPTIONS`) | `web-sdk/load-tiers` | App.tsx sequencer |
| `useConfig` / `getConfig` / `watchConfig` | `config_v2` | dozens of plugins |
| boot-trace store + Gantt + `benchmark_boot` | `perfs/boot-trace`, `debug/boot-profile` | perf work |
| `frontendHashResource` + `useStaleFrontend` | `build` | reload button |

### Background ([06](./06-jobs-and-events.md))

| API | Plugin | Consumers (examples) |
|---|---|---|
| `defineJob`, `enqueue({tx})`, dedup, cron, `NonRetryableError`, `ctx.step/waitFor/sleep` | `infra/jobs` | fork, mail tick, history snapshots, sweeps, monitors |
| `defineTriggerEvent`, `emit({tx})`, `Trigger()`/`trigger()`, emission log | `infra/events` | conversation lifecycle → title/category/summary/auto-launch |
| `createFileWatcher` | `infra/file-watcher` | git-watcher, config, transcripts, plugin-tree |
| `refAdvanced` event + `refHeadResource` + `lastKnownMainSha` | `infra/git-watcher` | build, commits-graph, review, tasks |
| queue introspection + queue-health reports + MCP tool | `infra/jobs` + `debug/queue-health` | Debug panes, agents |

### Side channels ([07](./07-side-channels.md))

| API | Plugin | Consumers (examples) |
|---|---|---|
| `clientLog` / `Log.channel().publish`, `/ws/logs` | `primitives/log-channels` | 19 publishers; Debug → Logs |
| `/ws/terminal` + bun-pty | `primitives/terminal` | conversation terminal-pane (tmux attach) |
| transcript watcher + `jsonl-events` resource | `conversations/transcript-watcher` + `jsonl-viewer` | the conversation UI |
| `defineReportSink` / `recordReport` | `primitives/report-sink` + `reports` | boundary/endpoint/mutation/wedge sinks; all monitors |
| `getAccessToken` (central) / `getTokenFromCentral` (worktree), `authStateResource` | `auth` | mail sync, backup targets |
| `getSecret`/`setSecret` | `infra/secrets` | auth tokens, config secret fields |
| `ZeroRoot` + `useZeroResource` | `database/zero/client` | debug/zero-test (pilot) |
| `safeFetch`, asset-mirror, claude-cli, host-read-pool | `infra/*` | wallpaper import, sonata assets, titles, git reads |

## 3. The enforcement net (why the idioms stay the only idioms)

| Rule | Enforced by |
|---|---|
| No raw `fetch("/api/…")` from web | `no-raw-web-fetch` lint + `endpoints:typed-web-fetches` check |
| No raw JSON `Response` handlers | `endpoints:no-raw-json-handlers` check |
| No SSE / ad-hoc live-state WS in TS | `./equin check` (raw `text/event-stream` ban + WS route allow-list) |
| No `.notify()` on DB-backed resources | type shape (`defineResource` returns no notify) + `no-db-backed-notify` check |
| Keyed resource without scope policy | `defineResource` overloads (won't compile) |
| No `pending ? [] : data` collapse | `live-state/no-pending-data-collapse` lint |
| No floating promises / bare catch | `promise-safety` lints |
| No raw `@parcel/watcher` / `EventSource` / ResizeObserver | watcher-safety / networking conventions / resize-observer-safety lints |
| No polling loops | convention + review; the two sanctioned exceptions (watcher reconcile tick, mail cron) are documented in place |
| Registry/codegen drift | `plugins-registry-in-sync`, `plugins-doc-in-sync`, `migrations-in-sync`, `snapshot-chain-intact` checks |

## 4. Known gaps / current frontier (honest edges of the system)

- **Manual `affectedMap` can drift** from what a loader really reads — the
  "silent FULL" ceiling. Mitigated by read-set diffing + `_debug`
  observability; the structural fix (declarative queries deriving loader +
  delta together) is Axis A of the
  [sync-engine vision](../2026-06-21-global-live-state-ivm-and-instant-client-vision.md).
- **Boot-snapshot covers only param-less resources**; parametrized ones pay a
  sub-ack round trip on deep links (softened by HTTP priming).
- **Eager/deferred allowlists are hand-maintained** (`DEFERRABLE_APPS` /
  `EAGER_EXCEPTIONS`); codegen from boot-critical markers is the stated
  follow-up.
- **Reads execute server-side** — every filter/sort interaction is a
  round-trip (fast on localhost, but not 0ms). ~~The Zero pilot vs Axis B
  in-house store is the open architectural decision.~~ **Resolved
  (2026-07-02):** the in-house stack is the committed direction; the Zero pilot
  is **frozen and fenced** behind `SINGULARITY_ZERO_CACHE`
  ([`plugins/database/plugins/zero/CLAUDE.md`](../../plugins/database/plugins/zero/CLAUDE.md),
  super-plan Track 2). Re-evaluate only if Axis B becomes a committed track.
- **Deployment model was an unrecorded assumption** — single-user/single-machine
  couplings (trust-auth PG, per-worktree forks, localhost subdomains, per-origin
  leader election, host-local secrets) ran deep with no written status.
  **Resolved (2026-07-02):**
  [ADR — one instance per user](../2026-07-02-global-adr-single-instance-per-user.md)
  records the decision, enumerates the sanctioned couplings, and adds the
  deferred `authorize` subscription seam (super-plan Track 5).
- **Cron placement is convention-checked, not type-checked** — a missing
  `perWorktree` flag is a semantic decision the compiler can't see.
- **Fork excludes mail bulk data by table name list** in the fork code — a
  hardcoded coupling that would rot if mail renamed tables.
