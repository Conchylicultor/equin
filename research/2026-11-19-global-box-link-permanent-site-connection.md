# Box link: a permanent connection from main to every deployed site

Task: task-1795056663-i3h84l. Plan only — nothing here is implemented yet.
Prototype of the row: `proto-1792516777-e95kao` (option group *Deployed site*).

## Context

Today main knows about a deployed site's server (the *box*) only when it asks:

- **Data** — `site-mirror/pull` copies the box's mirrored tables (analytics, site messages,
  site reports) on tab open, on Sync now, and from an hourly `site-mirror.pull-all`. The box
  has no change signal reaching here, so the copy is up to an hour stale.
- **Health** — `deploy/health` probes SSH (`uname -sm`) only when the user clicks Check.
  Nothing knows whether equin is still running on the box, nor its CPU / memory / disk.
- **Deploy** — `remote-deploy`'s one button (`POST /api/deploy/deployments/:id/run
  { verb: "update" }`) lives only on the site page.

**Outcome.** While main is up it holds one permanent link to each box. The link carries
small **signals** ("mirror log advanced", a 15 s heartbeat with the box's metrics), never
data: data keeps flowing through the cursored table-mirror pull, so a lost signal costs
nothing — every reconnect runs one catch-up pull. On top of it, the health report gets one
row per deployed site (live visitors, sparkline, server meters, sync freshness, Deploy in
place) — the prototype's six states: live, deploying, behind main, reconnecting, down,
deploy failed.

## Decisions

| Point | Decision |
|---|---|
| Doorbell, not pipe | The link carries signals; the mirror stays the one data path. No logical replication (rejected in `2026-11-12-global-table-mirror.md`: WAL pinned while the laptop sleeps, schema coupling). |
| Transport | **An SSH tunnel per server** — `ssh -N -L <scratch>/d<n>.sock:127.0.0.1:<loopbackPort>` — and the stream read locally with `fetch(url, { unix })`. Not `curl -N` over ssh: no stdout plumbing through the daemon, and the layers fail apart (ssh dead → unreachable; ssh up but the fetch refused/502 → *equin stopped*; 404 → release too old). The request still enters through the box's gateway, so `hostOnly`'s one-hop rule holds. |
| Stream format | NDJSON over `ndjsonResponse` (the `no-raw-sse` check bans SSE). Heartbeat every 15 s keeps it inside Bun's 60 s `idleTimeout`; the Go gateway flushes chunked responses immediately. |
| Box push | The box learns "the mirror log advanced" from a `pg_notify` added to table-mirror's source triggers — no polling on the box. |
| Visitor numbers | **Computed locally from the mirrored analytics**, not sent in the heartbeat: once the doorbell keeps the copy seconds-fresh, visitors now / today / the 1 h sparkline are analytics' own SQL on the replica (`sourceNow` as "now"). One source of truth, no history table. The heartbeat carries only what no database holds: host metrics and which build is running. |
| Ring storm | A busy site's engagement beacons bump `last_at` several times a second. The box coalesces (one ring per set per 2 s); main spaces pulls (≥ 5 s after the last attempt; a sink set keeps its own `minIntervalMs` pace). |
| ControlMaster | Not needed. Phase 4 routes mirror pulls through the tunnel's socket instead, which removes the per-pull SSH handshake. |
| Health rows | `HealthReport.Row` is static today. Add a generic **row set** (`kind: "set"`): one contribution yields N keyed rows from a live list. |
| Where it runs | Real boxes: main only (one instance per user). Demo stand-in boxes: every namespace, through this instance's own gateway with no tunnel — so a worktree can exercise the whole path. |

## Layout

New umbrella `plugins/apps/plugins/deploy/plugins/box-link/`:

- **`core/`** — the stream protocol (zod), the link-state union, the `deploy.box-links` live
  value, the route constant.
- **`plugins/box/`** (server, ships on the box) — `GET /api/host-only/box-link/stream`
  wrapped in `hostOnly`; the `BoxSignal` contribution kind (`{ source, subscribe(emit) }`);
  the heartbeat producer. Ships wherever a mirror set ships (imported by `site-mirror/box`).
- **`plugins/link/`** (server, local) — the tunnel daemon, the stream client, the state
  reducer (`shared/`, pure), persistence; exports `onBoxSignal(source, fn)` and
  `onBoxHello(fn)`; `POST /api/box-link/:deploymentId/retry`.
- **`plugins/site-row/`** (web) — the health-report row set and two render slots,
  `SiteLive.Section` and `SiteLive.Action` (both `{ deploymentId }`), so each owning plugin
  contributes its own part (collection-consumer separation).

Changes to existing plugins:

| Plugin | Change |
|---|---|
| `infra/ssh` | Split `runHermetic` (`server/internal/session.ts`) into `materializeHermetic(target)` → `{ dir, argv(extra, positionals), dispose() }`, the lifetime owned by the caller. Add `sshTunnelArgv(handle, forwards)`: `-N`, `ExitOnForwardFailure=yes`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `StreamLocalBindUnlink=yes`. Export the stderr classifier (`classify.ts`). `isolationOptions` stays written once. |
| `infra/spawn/daemon` | Process launch gets `onSpawn(ctx)` with `ctx.ready()` (so `healthy: "ready"` works for a process, not only a worker); `restart.giveUp: "never"` (typed, explicit); `instance.respawnNow()`; `{ code, signal }` on exit transitions. Today 5 rapid deaths → `gave-up`, which would kill the link the first time the laptop is offline. |
| `infra/ndjson-stream` | `ndjsonResponse(produce, { signal })` — `produce` gets the request's abort signal, stream `cancel` aborts it (today a disconnected client leaks the producer). Add `readNdjson(body, signal)`. Doc: sanction "a host-only stream read by a peer process". |
| `database/table-mirror/source` | `PERFORM pg_notify('table_mirror_log', <set id>)` in each `tm_log_*` function and `tm_truncated` (Postgres folds identical payloads per transaction). Channel ≠ `table_mirror` (the replica's). Export `onMirrorLogAdvanced(fn)`, modelled on replica's `notify.ts`, including its lost-then-re-signal path. |
| `deploy/site-mirror/box` | Contributes `BoxSignal({ source: "table-mirror" })` → `{ setId }`, throttled per set. |
| `deploy/site-mirror/pull` | `onBoxSignal` → `requestPull` with `runAt = max(now, lastAttempt + 5 s)` (sink sets: `+ minIntervalMs`); `onBoxHello` → pull every replica of that deployment (catch-up). Hourly pull-all stays as the safety net. |
| `deploy/analytics/collect` | Index `analytics_visits (last_at)`. (Verify existing replicas pick it up — replica tables are `LIKE … INCLUDING INDEXES` at creation.) |
| `deploy/analytics/dashboard` | `analytics.pulse` live value per deployment (visitors now, today, per-minute sparkline) via `readSiteMirror` + `onSiteMirrorApplied`; contributes the Visitors section. |
| `deploy/site-messages/inbox` | Contributes the "N new messages" link (count since a stored `lastSeenAt` — there is no read state today). |
| `shell/health-report` | The `kind: "set"` row. |
| `deploy/remote-deploy` | Contributes its existing Deploy button as a `SiteLive.Action`. |

## The stream (NDJSON, `v: 1`)

- `hello { v, startedAt, buildId, signals: string[] }` — on connect; main treats it as
  "connected" and runs the catch-up pull.
- `beat { at, seq, host: { cpu: { busyPct | null, cores, load1 }, mem: { used, total },
  disk: { used, total }, uptimeSec } }` — every 15 s. CPU from the `/proc/stat` delta
  between beats (null on the first); memory from `packages/host-memory` `readHostMemory()`;
  disk from `fs.statfs` on the install dir.
- `signal { source, payload }` — payload parsed by the owning plugin's handler with its own
  schema.
- Unknown frame kinds are ignored (an older main can read a newer box); an unsupported `v`
  → `outdated`. On abort the handler drops its LISTEN and timers.

## The local link

- **One tunnel per server**, one forward per deployment on it; argv rebuilt per respawn; a
  deployment-set or key change restarts it. Daemon: `where: "main"`, `healthy: "ready"`
  (ready = the socket file appeared — ssh binds it only after auth), backoff 2 s → 2 min,
  `giveUp: "never"`. Fatal stderr classes (auth, host-key mismatch, forwarding refused) →
  `stop()` and `refused`, never retried. Socket names `d<n>.sock` (macOS's 104-byte limit,
  asserted).
- **One stream client per deployment** while its tunnel is ready; bounded backoff via
  `setAwakeTimeout` (a bound around a network peer, not a fix for our own code).
- **Watchdog**: 45 s without a frame (3 missed beats) aborts the stream.
- **Wake** (`machine-sleep` `onSleepReadingChanged`) and *Retry now* → `respawnNow()` and an
  immediate stream restart.

### State machine (pure reducer, per deployment)

| State | When |
|---|---|
| `connecting` | tunnel spawned, no hello yet |
| `live` | hello received, beats current |
| `reconnecting { cause }` | was live, lost, within grace (2 min, or any time just after a wake). `slept` (`sleptDuring(lastHeard, now) > 0`), `network` (ssh dns/unreachable/timeout), `restarting` (stream ended while a deploy run is active) |
| `down` | tunnel ready but the fetch is refused / 502, past grace, no run active — "SSH answers, equin is not running" |
| `unreachable` | ssh transport failures past grace; when every link fails alike, "this computer looks offline" |
| `refused` | key or host key rejected, or forwarding disabled — the user must act |
| `outdated` | stream route 404, or unsupported `v` — "deploy it again"; retried after the next successful deploy run |

*Deploying*, *failed / reverted* and *behind main* are not link states: the row overlays
them from `deployRuns` and `runningCommit` (remote-deploy).

### Storage

- Live state plus the latest beat: in memory, served as the `deploy.box-links` live value
  (`source: "external"`, one value for the handful of deployments).
- Side-table `deploy_deployments_ext_box_link` (like `deploy_servers_ext_health`): `state,
  since, lastHeardAt, lastBeat jsonb, lastError`, written **on state changes only**, read at
  boot. "Last heard" and the dimmed meters show only outside `live`, so the value captured
  at the change is exactly what they need.

## Visitor SQL (on the replica, `$now = sourceNow`)

```sql
-- visitors now
SELECT count(DISTINCT visitor_id) FROM analytics_visits
WHERE last_at > $now - interval '5 minutes' AND NOT owner;
-- 1 h sparkline, per minute
WITH v AS (SELECT id, visitor_id FROM analytics_visits
           WHERE last_at >= $now - interval '1 hour' AND NOT owner)
SELECT floor(extract(epoch FROM $now - h.ts) / 60)::int AS m, count(DISTINCT v.visitor_id)
FROM analytics_hits h JOIN v ON h.visit_id = v.id
WHERE h.ts >= $now - interval '1 hour' GROUP BY m;
```

"Today" reuses collect's existing `day` count (`visitorCounts`, `aggregate-sql.ts`).

## Health-report row set

```ts
interface SetRow extends Omit<RowCommon, "actions"> {
  kind: "set";
  title: string; // the set's name while pending
  useRows: Hook<() =>
    | { kind: "pending" }
    | { kind: "error"; summary: string }
    | { kind: "ready"; rows: readonly { key: string; title: string; status: HealthStatus }[] }>;
  glance?: ComponentType<GlanceProps & { rowKey: string }>;
  component?: ComponentType<{ rowKey: string }>;
  actions?: ComponentType<{ rowKey: string }>;
  remedy?: ComponentType<{ rowKey: string }>;
}
```

- One probe per set calls `useRows` once and publishes `${id}/${key}` statuses atomically
  (`withStatusesUnder(prefix, map)` in `web/internal/store`, dropping vanished keys);
  pending → one `unknown` entry. The panel expands a set in place in the slot order;
  `foldQuietRows` sees its items as ordinary rows.
- `useRows` reads ONE value — the site row's reads a server-folded `deploy.site-health`
  (link state + latest run + behind count). Per-deployment hooks (`analytics.pulse`) live
  only in `glance` / `component`, one component instance per item.

| Site | `HealthStatus` |
|---|---|
| live, up to date | `ok` — one line, like the prototype's second site |
| behind main | `ok`, title "N commits behind main" (blue, not a problem) |
| deploying | `ok`, `transitioning` |
| reconnecting | `attention`, `transitioning` |
| deploy failed / outdated | `attention` |
| down / unreachable / refused | `critical` |

Body: `SiteLive.Section` contributions (Visitors — analytics; messages link — inbox; Server
— box-link, dimmed when stale). Footer: `SiteLive.Action` (Deploy — remote-deploy's own
button, disabled with its reason while reconnecting / unreachable; Investigate —
deploy-history; Retry now — box-link; Restart site — phase 4). The same components can be a
`SiteOverview.Card` on the site page.

## Compatibility

- A box on an older release 404s the stream → `outdated` ("deploy it again"); the tunnel
  still proves SSH, the hourly pull carries on as today. Sections gate on
  `useDeploymentShips(…, "apps.deploy.box-link.box")`.
- sshd `AllowTcpForwarding no` → `refused`, worded "forwarding is disabled on the server".

## Phases

1. **Primitives** — daemon `ready` / `giveUp: "never"` / `respawnNow`; ssh hermetic handle +
   tunnel argv; ndjson abort + reader; mirror-log NOTIFY + `onMirrorLogAdvanced`.
2. **The link** — box route, tunnel, stream client, reducer, live value, side-table,
   doorbell → pulls (spacing + pace), wake kick. Then redeploy every site.
3. **UI** — row-set contract, site row + slots, `analytics.pulse` + the `last_at` index,
   Deploy action. Pixel-perfect to `proto-1792516777-e95kao`.
4. **Follow-ups** — mirror pulls over the tunnel socket (host-query picks the transport); a
   `restart` run verb (`systemctl restart` as a recorded run) behind *Restart site*; check the
   running `buildId` against `runningCommit`.

## Verification

- **Tests** (`./equin test <plugin>`):
  - the reducer — table-driven: slept / network / restarting / down / outdated / refused and
    the grace edges;
  - daemon — process `ready()`, `giveUp: "never"`, `respawnNow` skips backoff;
  - table-mirror/source (db) — NOTIFY on insert / update (key moves) / delete / cascade /
    truncate, re-signal after a lost session;
  - box route (db) — hello, a signal on insert, beats; abort releases the LISTEN;
  - site-mirror/pull — doorbell `runAt` honours spacing and a sink's pace;
  - health-report (jsdom) — pending → one unknown entry; ready merges N items; a vanished
    item is dropped.
- **e2e on a demo stand-in box** — write a visit, see visitors-now move within ~6 s; exhibits
  for the six prototype states, compared with `compare-diff.ts`.
- **Manual on a real box** — `systemctl stop` → down; sleep the laptop → reconnecting
  (slept); deploy → deploying, then live on the new `buildId`; an old release → outdated.
