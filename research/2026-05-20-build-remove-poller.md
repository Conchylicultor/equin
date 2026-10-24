# Remove build status poller — push-based frontend hash + auto-build detection

## Context

The `BuildButton` toolbar component polls `GET /api/build/status` every 30 seconds to detect two things:

1. **Stale tab** — `frontendHash` (MD5 of `web/dist/index.html`) changed since page load → show blue dot
2. **Auto-build triggered** — `autoBuildAt` timestamp changed → toast + spinner

After a build restarts the server, the WebSocket reconnects immediately but the hash poll can lag by up to 30 seconds, so the blue "refresh" dot appears long after the "Reconnected to server" toast. A WS-reconnect re-poll was added as a band-aid, but the real fix is eliminating the poller entirely.

Both signals can be delivered via push:
- **Hash**: a new `frontendHashResource` push resource. On WS reconnect after server restart, `useResource` automatically re-subscribes and the loader returns the new hash.
- **Auto-build**: already available in `buildHistoryResource` — a new row with `trigger === "auto"` and `finishedAt === null` signals an auto-build started.

## Plan

### 1. Add `frontendHashResource` descriptor

**File:** `plugins/build/core/resources.ts`

```ts
export const FrontendHashSchema = z.object({ hash: z.string() });
export type FrontendHash = z.infer<typeof FrontendHashSchema>;
export const frontendHashResource = resourceDescriptor<FrontendHash>(
  "build.frontendHash",
  FrontendHashSchema,
  { hash: "" },
);
```

### 2. Create server resource

**New file:** `plugins/build/server/internal/frontend-hash-resource.ts`

- `defineResource({ key: "build.frontendHash", mode: "push", loader })` with the hash computation lifted from `handle-build-status.ts` (`getFrontendHash`).

### 3. Notify after build completion

**File:** `plugins/build/server/internal/run-build.ts` — add `frontendHashResource.notify()` after the existing `buildHistoryResource.notify()` at line 82.

Belt-and-suspenders: the WS reconnect re-subscription already delivers the new hash, but explicit notify covers edge cases where the server doesn't fully restart.

### 4. Register resource, remove endpoint

**File:** `plugins/build/server/index.ts`

- Add `Resource.Declare(frontendHashResource)` to contributions
- Remove `handleBuildStatus` import and its `httpRoutes` entry
- Remove `getBuildStatus` import from `../core/endpoints`

### 5. Clean up auto-build tracker

**File:** `plugins/build/server/internal/build-run-job.ts` — remove `setLastAutoBuildAt` import and call.

**Delete:** `plugins/build/server/internal/auto-build-tracker.ts` and `plugins/build/server/internal/handle-build-status.ts`.

### 6. Remove endpoint definition

**File:** `plugins/build/core/endpoints.ts` — remove `getBuildStatus` export (only `triggerBuildEndpoint` remains).

### 7. Update barrel exports

**`plugins/build/core/index.ts`:** Remove `getBuildStatus`, add `frontendHashResource`, `FrontendHashSchema`, `FrontendHash`.

**`plugins/build/shared/index.ts`:** Add `frontendHashResource`, `FrontendHashSchema`, `FrontendHash` re-exports.

### 8. Rewrite `BuildButton`

**File:** `plugins/build/web/components/build-button.tsx`

**Remove:**
- `getBuildStatus()` fetch function and `BuildStatus` interface
- `autoBuilding` state, `loaded` state
- `lastAutoBuildAtRef`
- `applyStatus`, `pollNow` callbacks
- `setInterval` polling effect
- `subscribeWsStatus` reconnect effect
- Imports: `getHealth`, `waitForRestart`, `subscribeWsStatus`, `useCallback`

**Add:**
- `useResource(frontendHashResource)` for stale-tab detection
- `initialHashRef` + effect watching `hashResult.data.hash`: first non-pending value becomes baseline; subsequent changes set `staleTab = true`
- Auto-build toast derived from `buildHistoryResource`: when `latestRun` changes to a new in-flight auto-triggered row (guarded by an `initializedRef` to suppress on first load), fire "Auto-build triggered by new push" toast

**Key details:**
- `spinning` becomes just `building` (no more `autoBuilding`)
- `loaded` dot guard becomes `!hashResult.pending`
- `initializedRef` prevents toasts on initial page load — set `true` after both resources deliver their first non-pending value

### 9. Update CLAUDE.md and plugin docs

Update `plugins/build/CLAUDE.md` exports list. The generated `docs/plugins-details.md` will be updated by `./equin build`.

## Verification

1. `./equin build` succeeds
2. Open `http://<worktree>.localhost:9000`
3. Trigger a build from another terminal — verify:
   - Blue stale-tab dot appears promptly on WS reconnect (no 30s delay)
   - "Build succeeded" toast fires
4. Trigger an auto-build (push to main) — verify:
   - "Auto-build triggered by new push" toast fires
   - Spinner shows during build
   - Blue dot appears on reconnect
5. Reload the page with an in-flight build — verify no spurious toast on load
6. `./equin check` passes
