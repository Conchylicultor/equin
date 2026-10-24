# Fix: Non-blocking build button with resource-driven status

## Context

The Build toolbar button is broken — it times out and streams no logs. Root causes:

1. **`POST /api/build` blocks** until the entire build finishes (`handleBuild` awaits `runBuild("manual")`). The frontend fires it fire-and-forget, then polls `waitForRestart` with a **60-second timeout**. Builds routinely exceed 60s → "Build timed out" toast.

2. **`waitForRestart` detects success by polling `/api/health`** for a changed `startedAt` timestamp. This only changes after the build finishes AND the gateway hot-restarts the server — a fragile, indirect signal.

3. **Logs should stream** via the `/ws/logs` "build" channel — the architecture is correct (WS subscription + `buildLog.publish()` per-line). The timeout/blocking issue causes the UI to give up before logs arrive or shortly after.

The fix decouples the HTTP response from the build lifecycle. The build history resource (`buildHistoryResource`, push-mode) already tracks in-progress and completed builds with `finishedAt`/`exitCode` fields and pushes updates to all subscribers. It just isn't being used for status detection.

## Changes

### 1. Server: `plugins/build/server/internal/handle-build.ts`

Make `POST /api/build` return immediately instead of blocking.

- Remove `async`/`await` — fire `runBuild("manual")` in the background with `.catch(() => {})`
- Return `{ ok: true }` immediately
- `runBuild` already coalesces concurrent calls via its in-process mutex, so double-clicks are safe
- `doRunBuild` handles errors internally (records `exitCode` in DB, calls `buildHistoryResource.notify()`)

### 2. Client: `plugins/build/web/components/build-popover-content.tsx`

Replace `waitForRestart` polling with the push-mode `buildHistoryResource`.

- **Derive `building`** from `useResource(buildHistoryResource)`: `building = latestRun?.finishedAt === null`
- **Show toast on completion** via a `useEffect` watching `latestRun.id` + `latestRun.finishedAt` transitions. A `trackedBuildRef` gates toasts so they only fire for builds the user has seen start (prevents spurious toasts on page load).
- **Simplify `handleBuild`** to just fire the POST and show error toasts on fetch failure.
- **Remove** `getHealth`/`waitForRestart` imports from `@plugins/health/web`.

### Not changed

- `run-build.ts` — already correct (DB insert + notify on start, update + notify on finish, gateway restart on success)
- `build-run-job.ts` — jobs can block, no issue
- `build-button.tsx` — auto-build detection is a separate concern (still polls `/api/build/status`)
- WS log streaming — architecture is correct; fixing the timeout should let logs surface properly

## Edge cases

- **Double `useResource`**: `BuildPopoverContent` + `BuildHistoryList` both call `useResource(buildHistoryResource)`. TanStack Query shares the cache entry; WS subscription is refcounted.
- **Build in progress on popover open**: `latestRun.finishedAt === null` → `building = true` immediately. Toast fires when it completes (tracked via ref).
- **Build triggered from another tab**: `building` goes true (button disabled), but no toast fires when it completes (ref wasn't set by this tab's handleBuild).
- **Server restart after build**: Live-state WS auto-reconnects, replays subscriptions, gets fresh data.

## Verification

1. `./equin build` from the worktree to deploy
2. Open the Build popover and click Build
3. Confirm: button shows "Building..." immediately, POST returns fast
4. Confirm: logs stream in the log view in real-time
5. Confirm: on build completion, success/failure toast appears
6. Confirm: build history updates (new row with transition from running to finished)
7. Confirm: clicking Build during an in-flight build is a no-op (button stays disabled)
