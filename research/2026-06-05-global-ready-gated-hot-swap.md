# Ready-gated hot-swap: gate the gateway swap on real backend readiness

## Context

`./equin build` hot-restarts a worktree backend. The gateway is *supposed* to keep the old backend serving until the new one is ready, then swap atomically — zero downtime. In practice, on builds **with a new migration**, the app shows a "Server restarting…" window of a few seconds, inconsistent in length.

Root cause, in two layers:

1. **Gateway readiness is too coarse.** `waitReady` (`gateway/worktree.go:611`) only does `net.DialTimeout("unix", socketPath)` — "socket accepts a connection" = ready. But the backend binds its socket (`server-core/bin/index.ts:179`) *before* the `onReady` phase, and migrations + DB warm + config-registry init all live in `onReady`. So the gateway swaps to a backend that is accepting connections but hasn't applied migrations yet. The client's `/ws/notifications` then reconnects (backoff ladder `[500,1000,2000,5000]ms`) and its resource loaders query schema the pending migration hasn't created → `sub-error: unknown-key` / stale window. The variance comes from how many backoff steps get burned waiting for a half-booted backend.

2. **The `onReady` barrier the bug relies on isn't actually enforced.** `database/CLAUDE.md` documents *"runMigrations runs before any other plugin's onReady; consumers can safely use the DB in their onReady."* But the `onReady` runner (`server-core/bin/index.ts:233-253`) fires every no-`dependsOn` plugin's hook concurrently via `Promise.all([]).then(...)`. `database` has no `dependsOn` and is not special-cased, so its migration work races every other `onReady` (and incoming requests). It only *appears* safe because migrations are usually instant no-ops on a forked DB — exactly until a real migration makes them slow.

**Intended outcome:** the gateway hot-swaps only once the new backend is *genuinely ready to serve* — migrations applied, DB pool warm, config registry built — while genuinely-background `onReady` work (file watchers, git-log reconcile, graphile-worker DDL) stays non-blocking so migration-free builds remain fast. As a structural bonus, the fix makes the documented "DB ready before any `onReady`" guarantee real.

## Approach (chosen)

Introduce a first-class **blocking-readiness phase** in the backend boot lifecycle, expose it over HTTP as `GET /api/health/ready`, and switch the gateway's `waitReady` to poll that endpoint (with a graceful 404 fallback for backends built before this change).

Boot sequence becomes:

```
register → collectContributions → routes → Bun.serve (socket up; /ready → 503)
  → onReadyBlocking  (HARD BARRIER: migrations, DB warm, config registry)
  → markServerReady()           ← /ready now 200 → gateway swaps here
  → onReady  (background: watchers, reconcile, workers)
  → onAllReady
```

The old backend (and its WebSocket) keeps serving the entire time the new one runs `onReadyBlocking`; the client only reconnects *after* the swap, landing on a fully-ready, migrated backend.

## Changes

### 1. server-core — new lifecycle phase + readiness flag

**`plugins/framework/plugins/server-core/core/types.ts`**
- Add an `onReadyBlocking?: () => void | Promise<void>` hook to `ServerPluginDefinition` (place above `onReady`, with a doc comment: *runs after the socket binds but before the server reports ready and before any `onReady`; a hard barrier; use only for work that must complete before the backend can correctly serve requests — DB migrations/warmup, registry init. `loadBearing` rejection aborts boot*).

**New `plugins/framework/plugins/server-core/core/readiness.ts`**
```ts
let ready = false;
export function markServerReady(): void { ready = true; }
export function isServerReady(): boolean { return ready; }
```
Export `isServerReady`, `markServerReady` from `core/index.ts`.

**`plugins/framework/plugins/server-core/bin/index.ts`** — insert a new phase between the `Bun.serve` block (ends ~line 224) and the `onReady` phase (line ~227):
```ts
// ── onReadyBlocking ── hard barrier: must finish before we report ready.
{
  const end = profilerStart("onReadyBlocking", "onReadyBlocking", "Blocking Ready");
  await Promise.all(
    ordered.map(async (p) => {
      if (!p.onReadyBlocking) return;
      try { await p.onReadyBlocking(); }
      catch (err) {
        console.error(`[plugin.${p.id}] onReadyBlocking failed`, err);
        if (p.loadBearing) throw err;
      }
    }),
  );
  end();
}
markServerReady();
```
Runs as a parallel barrier (same shape/`loadBearing` semantics as the `onAllReady` block at `:260-273`). The blocking plugins (`database`, `config_v2`) are independent infra, so no `dependsOn` gating is needed here; if a future blocking plugin needs ordering, revisit then. After this, the existing `onReady` phase runs unchanged — now guaranteed to see a migrated DB and a ready registry.

### 2. database plugin — move migration/warm work into the blocking phase

**`plugins/database/server/index.ts`** — rename `onReady` → `onReadyBlocking` (body unchanged: `awaitDbReady()` → `warmPool()` → `runMigrations(db)`). Keeps `loadBearing: true`, so a broken migration still aborts boot → gateway `waitReady` times out → restart fails → old backend stays up (zero downtime, the existing failure contract).

### 3. config_v2 plugin — split blocking vs background

**`plugins/config_v2/server/index.ts`** — split the current `onReady`:
- `onReadyBlocking() { await initRegistry(); }` — registry build (which calls `markRegistryReady()` in its `finally`).
- `onReady() { await initConfigWatcher(); }` — the `@parcel/watcher` file watcher is genuinely background.

(Included so config-driven resources are ready at swap time, avoiding brief loading spinners. Safe because `initRegistry` already opens its gate in a `finally`.)

### 4. health plugin — expose `GET /api/health/ready`

**`plugins/health/shared/endpoints.ts`** — add:
```ts
export const getHealthReady = defineEndpoint({ route: "GET /api/health/ready" });
```
**New `plugins/health/server/internal/handle-health-ready.ts`**:
```ts
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/core"; // confirm exact HttpError export path
import { isServerReady } from "@plugins/framework/plugins/server-core/core";
import { getHealthReady } from "../../shared/endpoints";

export const handleHealthReady = implement(getHealthReady, () => {
  if (!isServerReady()) throw new HttpError(503, "server not ready");
  return { ready: true };
});
```
**`plugins/health/server/index.ts`** — add `[getHealthReady.route]: handleHealthReady` to `httpRoutes`.

(No `response` zod schema needed — the gateway reads only the status code, and no TS client consumes it yet. Add one later if a web client does, per the `fetchEndpoint-needs-response-schema` note.)

### 5. gateway — poll `/api/health/ready` instead of bare socket dial

**`gateway/worktree.go`** — rewrite `waitReady` (`:611`), keeping its signature `(socketPath string, timeout time.Duration, exitCh <-chan struct{}) error`. Build one `http.Client` whose `Transport.DialContext` dials the UDS (reuse the exact closure from `newReverseProxy` at `:644-648`), with a short per-request timeout (~2s). Loop until the deadline:
- `GET http://backend/api/health/ready`
- transport/dial error (socket not up / connection refused) → not ready; `select { case <-exitCh: return err; case <-time.After(100ms): }`; continue
- status **200** → ready, `return nil`
- status **404** → endpoint absent (backend predates this change) → **fallback: `return nil`** (legacy "socket accepts = ready" behavior)
- status **503** / other → not ready; sleep + continue
- `exitCh` fired → `return errors.New("backend exited before ready")`
- deadline exceeded → `return fmt.Errorf("readiness timeout after %s", timeout)`

Always drain + close `resp.Body`. Both callers — cold start (`Ensure`, `:260`) and hot restart (`Restart`, `:345`) — inherit this for free with the existing 15s `ReadyTimeout`. `net/http` is already imported (used by `httputil`); add `io` if needed for body drain.

### 6. Docs

- `gateway/CLAUDE.md` — "Backend Contract" item 2 and the worktree-registry note: replace "gateway polls readiness with `net.Dial("unix", path)`" with "gateway polls `GET /api/health/ready` over the socket, falling back to socket-accept on 404".
- `database/CLAUDE.md` "Bootstrap" + `server-core/CLAUDE.md` lifecycle prose — document the new `onReadyBlocking` phase and that it is the *enforced* barrier guaranteeing a migrated DB before any `onReady`.
- Plugin-reference autogen blocks (health/database/config_v2/server-core) regenerate via `./equin build`; the `plugins-doc-in-sync` check keeps them honest.

## Critical files

| File | Change |
|------|--------|
| `plugins/framework/plugins/server-core/core/types.ts` | add `onReadyBlocking?` hook |
| `plugins/framework/plugins/server-core/core/readiness.ts` | **new** — `isServerReady` / `markServerReady` |
| `plugins/framework/plugins/server-core/core/index.ts` | export readiness helpers |
| `plugins/framework/plugins/server-core/bin/index.ts` | new blocking-barrier phase + `markServerReady()` (between `:224` and `:227`) |
| `plugins/database/server/index.ts` | `onReady` → `onReadyBlocking` |
| `plugins/config_v2/server/index.ts` | split: `initRegistry` blocking, `initConfigWatcher` background |
| `plugins/health/shared/endpoints.ts` | add `getHealthReady` |
| `plugins/health/server/internal/handle-health-ready.ts` | **new** handler |
| `plugins/health/server/index.ts` | wire the route |
| `gateway/worktree.go` | rewrite `waitReady` to HTTP-probe with 404 fallback |

## Verification

> **Gateway change requires a gateway rebuild + restart.** The gateway is a long-running Go binary started once via `./equin start` (a system-level op). The `waitReady` change only takes effect after the gateway is recompiled and restarted — **the user must run `./equin start`**; `./equin build` alone will not pick it up. Flag this explicitly.

1. **Build the backend changes:** `./equin build` (regenerates docs, restarts the worktree backend). Confirm checks pass (`plugins-doc-in-sync`, `eslint`, boundaries).
2. **Probe the endpoint:** `curl -i http://<worktree>.localhost:9000/api/health/ready` → `200 {"ready":true}` once up.
3. **Rebuild + restart the gateway:** `./equin start`, then confirm the gateway is healthy (`curl http://singularity.localhost:9000/gateway/worktrees`).
4. **Force a slow boot to expose the old bug / confirm the fix:** make a trivial schema change (new nullable column in some plugin's `tables.ts`) so the next build generates a real migration. Run `./equin build` and watch the build button via `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000 --click "Build" ...`:
   - The "Server restarting…" / WS reconnect window should now begin **only after** the new backend is fully ready, and the reconnect should land on a migrated backend — no `sub-error: unknown-key` in the browser console, no stale-data flash.
   - Compare against `main` (pre-change) where the same migration build shows the multi-second reconnect.
5. **Failure contract intact:** introduce a deliberately broken migration; confirm `Restart` fails, the old backend keeps serving (zero downtime), and the build is marked failed.
6. **404 fallback (reason + spot-check):** the new gateway against a backend without `/api/health/ready` must still come up via the legacy path. Spot-check by temporarily pointing the probe at the existing `/api/health` (which 200s) — primarily a code-review confirmation since reproducing a stale backend is awkward.
7. **Cold start:** kill the worktree backend, hit `/api/...`; the gateway should lazy-spawn and only serve once `/ready` is 200.
