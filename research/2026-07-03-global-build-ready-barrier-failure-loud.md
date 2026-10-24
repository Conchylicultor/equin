# Make `./equin build` fail loudly when the new backend fails its ready barrier

## Context

`./equin build` restarts the worktree backend and then probes `/api/health`
to smoke-test the boot. Today it reports **"Deployed" with exit 0 even when the
freshly-restarted backend never passed its `onReadyBlocking` ready barrier** — so
a boot-blocking bug (migration failure, `rebuildTriggers` failure, the new
change-feed dead-scope invariant, …) silently leaves the app serving stale code
behind a green deploy.

### Root cause (traced end-to-end)

The gateway's hot restart is **synchronous and blue/green** and fails *safe*:

- `Worktree.Restart()` (`gateway/worktree.go:394-461`) spawns the new backend on
  the alternate socket, then blocks in `waitReady()` polling
  `GET /api/health/ready` (gated on `isServerReady()` → the `onReadyBlocking`
  barrier). On success it atomically swaps `w.active = newBk` and returns
  `200 {"restarted":true}`. On failure it **SIGKILLs the new backend**, reverts
  `w.state` to `StateRunning` (never `StateBroken` — that's only a *cold-start*
  outcome), leaves the old backend as `w.active`, and returns
  `500 "hot restart failed (old backend intact): <readiness timeout | backend exited before ready>"`.
- So after the restart POST returns: **200 ⇒ new backend is live+ready and now
  served; 500 ⇒ new backend is dead and the OLD backend still serves stale code.**

`build.ts` mishandles this (`plugins/framework/plugins/cli/bin/commands/build.ts`):

1. On `500` it calls `getWorktreeState()` and only hard-fails when
   `state === "broken"` — a state a failed *hot restart* never produces. It falls
   through to a `console.warn` and continues (lines 1177-1193).
2. `probeHealth()` (lines 515-581) then fetches `/api/health` — an **unconditional
   liveness** endpoint (not `/api/health/ready`) — and checks only `resp.ok`. The
   still-running **old** backend answers `200 {ok:true, startedAt:<old>}`, so the
   probe passes. Nothing ever compares `startedAt` across the restart, so a stale
   process's `ok:true` is indistinguishable from a fresh one's.
3. → `console.log("Deployed …")`, exit 0.

The health response already carries a per-process `startedAt` (set once at module
load — `plugins/infra/plugins/health/server/internal/handle-health.ts`), and the
**web** client already uses exactly the right pattern:
`waitForRestart(previousStartedAt)` polls `getHealth()` and treats
`startedAt > previousStartedAt` as "the new process is now serving"
(`plugins/infra/plugins/health/web/internal/client.ts:15-28`). The CLI just never
adopted it.

### Intended outcome

`./equin build` exits **non-zero** whenever, after the build, the worktree
is *not* serving the newly-built backend — i.e. the new process never passed its
ready barrier and the gateway kept serving the old one. This closes the contract
for **every** `onReadyBlocking` invariant, not just the change-feed one.

## Approach — CLI-only `startedAt`-advance verification (no gateway/Go change)

The task offers two options: (a) the gateway reports the ready-barrier outcome, or
(b) the health probe checks that `startedAt` actually advanced. We take **(b)** —
it is fully self-contained in `build.ts`, reuses the existing `startedAt` field
and the web client's proven pattern, needs no gateway rebuild, and is correct
because the gateway only ever routes to a backend that passed `waitReady` (so an
advanced served `startedAt` *proves* the new backend is both live and ready).

All changes are in **`plugins/framework/plugins/cli/bin/commands/build.ts`**.

### 1. Capture the pre-restart `startedAt`

Add a small helper (near `getWorktreeState`/`probeHealth`) that reads the
currently-served process identity, tolerating an absent/unreachable backend:

```ts
// Per-process identity of the backend currently served for `name`, or null when
// nothing is serving yet (cold start) or it's unreachable. The gateway only
// routes to a backend past its ready barrier, so a change in this value across a
// restart proves the NEW (ready) backend took over.
async function readHealthStartedAt(name: string): Promise<number | null> {
  try {
    const resp = await fetch(`http://${name}.localhost:9000/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { startedAt?: unknown };
    return typeof body.startedAt === "number" ? body.startedAt : null;
  } catch (err) {
    if (!(err instanceof TypeError) && !(err instanceof DOMException)) throw err;
    return null;
  }
}
```

Call it **immediately before** the restart POST (line ~1168) and hold the value:

```ts
const previousStartedAt = await readHealthStartedAt(name);
```

### 2. Capture (don't swallow) the gateway's restart error

In the `resp.status === 500` branch, read the gateway's error body for the failure
message and keep the existing cold-start `broken` fast-path:

```ts
} else if (resp.status === 500) {
  restartError = (await resp.text().catch(() => "")).trim() || null;
  const info = await getWorktreeState(name);
  if (info?.state === "broken") {
    console.error(`Server crashed during boot (state: broken): ${info.lastSpawnErr || restartError || "no error reported"}. Check server logs.`);
    finalizeBuildLog(false); process.exit(1);
  }
  console.warn(`Backend restart returned 500${restartError ? `: ${restartError}` : ""} — verifying the new backend took over…`);
}
```

`restartError` / `previousStartedAt` are declared in the handler scope so
`probeHealth` can use them.

### 3. Make `probeHealth` verify the NEW backend is serving

Change the signature to `probeHealth(name, previousStartedAt, restartError)` and:

- **Success predicate:** if `previousStartedAt == null` (genuine cold start — no
  prior backend) keep the current "any `resp.ok`" behavior; otherwise require the
  parsed `startedAt > previousStartedAt`. (The gateway swaps `w.active` to the new
  backend only after `waitReady`, so a served advanced `startedAt` ⇒ ready.)
- **On deadline with no advance (`previousStartedAt != null`):** this is a real
  deploy failure — the new backend never became the served backend and the gateway
  is still serving stale code. `console.error(...)` including `restartError` and a
  pointer to the backend log, then `finalizeBuildLog(false); process.exit(1)`.
  Do **not** fall through to the old "state === running ⇒ Server is up" branch
  (that "running" is the *old* backend).
- **On deadline for a cold start (`previousStartedAt == null`):** keep the existing
  load-aware leniency (`getWorktreeState` → `broken` exits 1, `starting`/`idle`
  warns and does not block — a stopwatch expiring under host load isn't a boot
  failure when there's no prior backend to fall back to).

This yields the correct behavior in every case:

| Scenario | restart resp | `startedAt` | build result |
|---|---|---|---|
| New backend ready, swapped | 200 | advances immediately | ✅ Deployed |
| New backend fails barrier / crash-loops (mode A) | 500 (killed) | never advances | ❌ exit 1 + gateway error |
| Slow-but-succeeds under load | 200 | advances within deadline | ✅ Deployed |
| Cold start, no prior backend | 404 | n/a (`previousStartedAt==null`) | waits; lenient onDeadline |

### 4. Keep the build log consistent on failure

The success path calls `writeBuildLogs(name); finalizeBuildLog(true)`. Ensure every
new `process.exit(1)` first calls `finalizeBuildLog(false)` (and `writeBuildLogs`
where the existing broken-path already does) so a failed deploy isn't recorded as a
successful build. Confirm `finalizeBuildLog` accepts a boolean during
implementation and mirror the existing broken-path precedent.

## Why not the other layers

- **Gateway persists a "last restart error" field (option a):** viable but requires
  Go changes + a new `WorktreeStatus` field + gateway rebuild. Unnecessary — the
  build already receives the error synchronously in the 500 body, and the
  `startedAt` check is a stronger, code-only guarantee. Left as an optional
  follow-up if we later want the error queryable after the fact.
- **Marking the worktree `broken` on hot-restart failure:** *wrong* — the old
  backend is healthy and still serving; `broken` would take the worktree offline.
  The gateway's fail-safe behavior is correct; the gap is purely on the build's
  verification side.

## Discovered, out of scope — file as follow-up tasks

1. **Non-`loadBearing` `onReadyBlocking` throws are silently swallowed.**
   `runGraphPhase` (`plugins/framework/plugins/server-core/bin/index.ts:261-284`)
   only rethrows for `loadBearing` plugins (`if (p.loadBearing) throw err`). A throw
   in a non-`loadBearing` plugin's `onReadyBlocking` is logged and swallowed, the
   barrier "passes", `markServerReady()` runs, and the gateway **promotes the
   degraded backend** (mode B). `change-feed` is *not* `loadBearing` yet its
   `onReadyBlocking` comment claims a hard prerequisite ("triggers exist before any
   traffic"); the reporter's change-feed dead-scope guard would be swallowed, not
   fatal — so even after this fix that specific guard won't fail the build until
   change-feed is made `loadBearing` (or the barrier treats throws as fatal
   per-hook). Note: `live-state-snapshot` sets `loadBearing:false` *intentionally*
   for graceful degradation, so a blanket "all throws fatal" is **not** safe — this
   needs a deliberate per-hook `critical` flag or making specific plugins
   load-bearing. **File a task.**
2. **Restart-POST timeout skips verification.** If `wt.Restart()` runs longer than
   the build's 130s POST timeout, the `catch` treats the `DOMException` as "gateway
   not reachable", sets `gatewayUp=false`, and skips `probeHealth` entirely →
   "Deployed" with no verification. Minor/rare; note as caveat, consider still
   probing on an abort timeout. **File a task.**

## Verification

1. `./equin build` on this branch with **no** boot regression → still prints
   "Deployed", exit 0. Confirm the log shows the new `startedAt`-advance probe
   passing quickly.
2. **Inject a boot-blocking failure** to prove the loud path. Temporarily make the
   `database` plugin's `onReadyBlocking` throw (it is `loadBearing`, so the new
   backend crashes and the gateway keeps the old one — the exact reported mode A):
   e.g. add `throw new Error("boot-barrier smoke test")` at the top of
   `plugins/database/server/index.ts`'s `onReadyBlocking`, then `./equin build`.
   Expect: non-zero exit, a clear error naming the stale-backend / ready-barrier
   failure and echoing the gateway's restart error, **no** "Deployed" line. Revert
   the injected throw and rebuild → back to green.
3. Sanity: `./equin check` passes (type-check + boundaries).

## Critical files

- `plugins/framework/plugins/cli/bin/commands/build.ts` — the only file changed
  (`readHealthStartedAt` helper, capture `previousStartedAt`/`restartError`,
  reworked `probeHealth`, failure `finalizeBuildLog(false)` + `exit(1)`).
- Read-only references / precedent:
  - `plugins/infra/plugins/health/web/internal/client.ts:15-28` — `waitForRestart`
    (the `startedAt > previous` pattern to mirror).
  - `plugins/infra/plugins/health/server/internal/handle-health.ts` — `startedAt`.
  - `gateway/worktree.go:394-461` (`Restart`), `gateway/proxy.go:345-366`,
    `gateway/worktree.go:931-969` (`waitReady`) — the synchronous restart contract.
