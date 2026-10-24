# Simplify auto-build: fire-and-forget spawn

## Context

The server crashes in a retry loop because `run-build.ts` awaits the CLI, then self-restarts via the gateway — killing itself mid-graphile-worker-job. The job transaction never commits, so it retries on next boot.

Root cause: the server is both the executor of the build AND the subject of the restart.

## Fix

**Mental model:** spawn `./equin build` (without `--no-restart`) and let go. The CLI handles restart natively. Success = server gets restarted. Failure = server stays alive.

## Changes

### 1. `plugins/build/server/internal/run-build.ts`

Rewrite to fire-and-forget:

- `triggerBuild(trigger): void` replaces `runBuild(trigger): Promise<number>`
- Remove `--no-restart` from spawn args (CLI handles restart)
- Remove self-restart fetch (lines 79-86)
- `inflight` becomes a boolean flag, not a Promise
- `doRunBuild` runs detached — streams logs, awaits exit for failure reporting, but nobody awaits `doRunBuild` itself
- On success the server may die before `proc.exited` resolves — that's fine

### 2. `plugins/build/server/internal/build-run-job.ts`

```ts
run: async () => {
  // ... guards ...
  triggerBuild("auto"); // fire and forget, no await
},
```

Job returns instantly. Worker commits "complete". No race with SIGTERM.

### 3. `plugins/build/server/internal/handle-build.ts`

```ts
export function handleBuild(_req: Request): Response {
  triggerBuild("manual");
  return Response.json({ ok: true });
}
```

### 4. `plugins/build/server/index.ts` — orphan cleanup in onReady

On boot, mark any `finishedAt = null` rows as succeeded (if this server is alive, the last build worked):

```ts
await db.update(_buildRuns)
  .set({ finishedAt: new Date(), exitCode: 0 })
  .where(isNull(_buildRuns.finishedAt));
```

### 5. No frontend changes

- Logs: stream while server lives (covers entire compile phase)
- History: push resource works; orphan cleanup fills in `finishedAt`
- Spinner: `waitForRestart()` detects restart, clears it
- Stale-tab: `frontendHash` poll detects new build
- Toast: fires when `finishedAt` transitions (either from old server on failure, or from new server's orphan cleanup on success)

## Verification

1. Push to main → auto-build fires → no retry loop → server restarts cleanly
2. Introduce TS error → build fails → server stays alive → error toast
3. Click Build button → logs stream → restart or error
4. Query `build_runs` after restart → no orphaned rows
