# `git-watcher` plugin: unify ref-change signal across surfaces

## Context

The build plugin's "main is N commits ahead" toolbar dot and its auto-build trigger currently disagree. The dot is computed by `getMainAheadCount` (`plugins/build/server/internal/git-status.ts`), which runs `git fetch origin main` and counts `git log <build-commit>..origin/main`. Auto-build is triggered off the `pushLanded` event, emitted by `insertPush` in `plugins/tasks-core/server/internal/mutations/pushes.ts:39`. `insertPush` is only called from `plugins/tasks/server/internal/push-watcher.ts`, which silently drops any commit lacking both `Singularity-Conversation` and `Singularity-Push` git trailers (`push-watcher.ts:57`).

Real example confirmed on the current `origin/main`: commit `c1c23f27` carries `Singularity-Push` but no `Singularity-Conversation` trailer (likely a `--from-main` push). The watcher skips it, advances `lastSha` past it, never emits `pushLanded` → no auto-build. The dot's raw `git log` counts it → yellow dot. Result: dot yellow, build never runs.

The fix is structural. There should be a single signal — "local main moved" — that drives every reactive surface (auto-build, dot, push ingest, future commit-graph live updates). This plan extracts that signal into a new `plugins/infra/plugins/git-watcher/` plugin and rewires the existing consumers to read from it.

Goals:

1. Dot and auto-build cannot disagree, by construction.
2. Watch the local `refs/heads/main` (not `origin/main`). A `git pull` that ff-merges main locally still triggers; a remote-only push without a corresponding local update is intentionally invisible (acceptable since `./equin push` always merges into local main before pushing).
3. Close to instant via `fs.watch` (`@parcel/watcher`), with a low-frequency reconcile poll as safety net.
4. Per-worktree watchers are fine; worktrees are temporary.

## Design

### New plugin: `plugins/infra/plugins/git-watcher/`

Mirror the structure of `plugins/infra/plugins/attachments/` byte-for-byte (per the "mirror working precedent" rule):

```
plugins/infra/plugins/git-watcher/
  package.json                 # @singularity/plugin-infra-git-watcher
  CLAUDE.md
  shared/
    types.ts                   # RefHead schema + payload types
  server/
    index.ts                   # barrel
    internal/
      ref-head-resource.ts     # defineResource (mode: "push")
      ref-advanced-event.ts    # defineTriggerEvent (filter: refName)
      watcher.ts               # @parcel/watcher subscription + reconcile poll
      git-common-dir.ts        # cached `git rev-parse --git-common-dir`
      read-sha.ts              # `git rev-parse <refName>` → sha | null
```

#### Trigger event

```ts
// internal/ref-advanced-event.ts
export interface RefAdvancedPayload {
  refName: string;       // e.g. "refs/heads/main"
  sha: string;
  previousSha: string | null;
  [key: string]: unknown;
}

export const { event: refAdvanced, table: _refAdvancedTriggers } =
  defineTriggerEvent<RefAdvancedPayload>({
    name: "git.refAdvanced",
    filters: { refName: text("ref_name") },
  });
```

The `refName` filter column lets consumers scope to a specific ref (e.g. `refs/heads/main`) using the same `isNull/eq` pattern as `taskStatusChanged`.

#### Live-state resource

```ts
// internal/ref-head-resource.ts
type Params = { refName: string };

export const refHeadResource = defineResource<{ sha: string | null }, Params>({
  key: "git-watcher.refHead",
  mode: "push",
  schema: RefHeadSchema,
  loader: async ({ refName }) => ({ sha: await readSha(refName) }),
});
```

No `onFirstSubscribe`/`onLastUnsubscribe` — the watcher is always-on (started at plugin `onReady`) because there is always a server-side consumer (auto-build) interested in `refs/heads/main`. The watcher calls `refHeadResource.notify({ refName })` for any ref that changes; subscribers without a websocket subscription pay nothing.

#### Watcher implementation (`internal/watcher.ts`)

- Resolve once: `gitCommonDir = trim(spawn("git", ["rev-parse", "--git-common-dir"]))`. Cached for process lifetime.
- Subscribe via `@parcel/watcher` (already a dep — used by `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts`) to `<gitCommonDir>/refs/heads/` (recursive, no `ignore` list — small dir).
- Also watch `<gitCommonDir>/packed-refs` (single-file watch via the same parcel call against its parent dir + filter).
- Maintain `Map<refName, lastKnownSha>` initialized lazily on first event.
- Debounce 100 ms, ceiling 1000 ms (mirror `watch-edited-files.ts:100-119`).
- On debounce flush: re-resolve every refName currently in the map via `git rev-parse <refName>` (cheap; refs are small). For each ref where the sha differs from `lastKnownSha`:
  - Update `lastKnownSha`.
  - Call `refHeadResource.notify({ refName })`.
  - Call `refAdvanced.emit({ refName, sha, previousSha })`.
- Reconcile poll: `setInterval(reconcile, 30_000)`. Reconcile re-resolves all tracked refs and dispatches the same way. Defends against missed `fs.watch` events (kqueue exhaustion, etc.).
- Initial pass at `onReady`: resolve `refs/heads/main`, seed `lastKnownSha`, **do not emit** (no previous baseline to advance from). Server-side catch-up logic in consumers handles "did I miss anything across restart" — see below.

The set of "tracked refs" starts with `refs/heads/main` (always) and can grow as future surfaces register interest. For v1, only `refs/heads/main` is tracked; consumers requesting other refs via `refHeadResource` would add them on first subscribe (out of scope for this plan, but the API supports it).

#### Plugin barrel exports

Server barrel exports: `refHeadResource`, `refAdvanced`, `_refAdvancedTriggers` (for schema discovery).
Shared barrel exports: `RefHeadSchema`, `RefAdvancedPayload` type.

### Refactor: `plugins/build/`

#### Drop `git fetch origin main`

`plugins/build/server/internal/git-status.ts` becomes the loader of a new derived resource. Drop the `git fetch` line — the watcher feeds us local main, the dot now reflects local main only.

#### New derived resource for the dot

```ts
// plugins/build/server/internal/main-ahead-resource.ts
export const mainAheadCountResource = defineResource<{ count: number }, {}>({
  key: "build.mainAheadCount",
  mode: "push",
  schema: MainAheadCountSchema,
  dependsOn: [{ resource: refHeadResource, map: () => [{}] }],
  loader: async () => ({ count: await getMainAheadCount() }),
});
```

The `dependsOn` cascade re-runs the loader whenever `refHeadResource({ refName: "refs/heads/main" })` notifies. A subscriber to `refHeadResource` with `params: { refName: "refs/heads/main" }` is established at plugin `onReady` (server-side, no client needed) — see "Always-on subscription" below.

Actually, simpler: skip the dependency cascade entirely. Have the build plugin's `onReady` register a `refAdvanced` trigger that, in addition to enqueuing `buildRunJob`, calls `mainAheadCountResource.notify({})` directly. One signal source, one fan-out point. Detail in implementation phase.

`getMainAheadCount` itself: keep the implementation in `git-status.ts`, just drop the `git fetch` call. It still reads `web/dist/.build-commit` and runs `git log <stored>..HEAD` (note: against local HEAD of refs/heads/main, not origin/main).

#### Replace the auto-build trigger

`plugins/build/server/index.ts onReady`: replace

```ts
await trigger({ on: pushLanded, do: buildRunJob, with: {}, oneShot: false });
```

with

```ts
await trigger({
  on: refAdvanced,
  do: buildRunJob,
  with: { refName: "refs/heads/main" },
  oneShot: false,
});
```

`buildRunJob` itself is unchanged — it still reads `autoBuild` config, no-ops if disabled, runs `runBuild()`. Its `event: z.never()` contract stays; it doesn't care about the payload.

The startup catch-up at `onReady` (lines 38-43) stays as-is: if `autoBuild` and `getMainAheadCount() > 0`, enqueue once. This handles "main moved while server was down."

#### Toolbar dot

`plugins/build/web/components/build-button.tsx`: replace the polled `mainAheadCount` field with `useResource(mainAheadCountResource, {})`. Drop the 30 s `setInterval` if `frontendHash` and `autoBuildAt` can be moved to resources too — but to keep scope tight, **keep the 30 s interval for those two fields only**, and remove `mainAheadCount` from the `/api/build/status` response. The dot reads from `useResource`; the staleTab and toast logic continue to read from the polled response.

### Refactor: `plugins/tasks/server/internal/push-watcher.ts`

Replace the 1 Hz `setInterval(tick, 1000)` with a `refAdvanced` trigger.

- Define `pushIngestJob` (`defineJob`) that does the work currently in `tick()`: walk new commits between `lastSha` and current head, apply the trailer filter (`parseLog`'s `if (!conversationId || !pushId) continue;` — keep this filter, it's correct for the `pushes` table contract), call `recordCommits`/`recordMissing`.
- In `tasks/server/index.ts onReady`:
  - Run the existing initial reconcile (full main history → `recordMissing`) — unchanged.
  - Register `trigger({ on: refAdvanced, do: pushIngestJob, with: { refName: "refs/heads/main" }, oneShot: false })`.
  - Remove the `setInterval` and the module-level `lastSha` / `lastHealAt` state.
- The 60 s heal becomes a separate scheduled job or stays as a startup-only catch-up. Recommend dropping the periodic heal — the trigger plus the startup reconcile cover all gaps. (If we keep it, it'd be a separate cron-style job.)

The `lastSha` state moves into the watcher's `lastKnownSha` map; the ingest job reads the watcher's `previousSha` from the trigger event payload to know the range to walk.

## Critical files

**New:**
- `plugins/infra/plugins/git-watcher/package.json`
- `plugins/infra/plugins/git-watcher/CLAUDE.md`
- `plugins/infra/plugins/git-watcher/shared/types.ts`
- `plugins/infra/plugins/git-watcher/server/index.ts`
- `plugins/infra/plugins/git-watcher/server/internal/ref-head-resource.ts`
- `plugins/infra/plugins/git-watcher/server/internal/ref-advanced-event.ts`
- `plugins/infra/plugins/git-watcher/server/internal/watcher.ts`
- `plugins/infra/plugins/git-watcher/server/internal/git-common-dir.ts`
- `plugins/infra/plugins/git-watcher/server/internal/read-sha.ts`
- `plugins/build/server/internal/main-ahead-resource.ts`

**Modified:**
- `plugins/build/server/index.ts` — swap `pushLanded` trigger for `refAdvanced`; register `mainAheadCountResource`.
- `plugins/build/server/internal/git-status.ts` — drop `git fetch origin main`; reads local refs only.
- `plugins/build/server/internal/handle-build-status.ts` — remove `mainAheadCount` field.
- `plugins/build/web/components/build-button.tsx` — dot reads from `useResource(mainAheadCountResource)`.
- `plugins/build/package.json` — add `@singularity/plugin-infra-git-watcher` dep.
- `plugins/tasks/server/index.ts` — register new ingest job + `refAdvanced` trigger; remove `startPushWatcher` setInterval call (keep only initial reconcile).
- `plugins/tasks/server/internal/push-watcher.ts` — split into ingest-job module + initial-reconcile helper. Remove `setInterval`, `lastSha`, `lastHealAt`.
- `plugins/tasks/package.json` — add `@singularity/plugin-infra-git-watcher` dep.
- `web/src/plugins.ts` and `server/src/plugins.ts` — register `git-watcher`.

## Reused functions

- `defineResource` from `@server/resources` (server/src/resources.ts) — `mode: "push"` with parameterized `loader`.
- `defineTriggerEvent` from `@plugins/infra/plugins/events/server` — same pattern as `pushLanded` and `taskStatusChanged` (`plugins/tasks-core/server/internal/tables-events.ts`).
- `trigger` from `@plugins/infra/plugins/events/server` — same call shape as today's `pushLanded` registration.
- `defineJob` from `@plugins/infra/plugins/jobs/server` — for the new `pushIngestJob`.
- `useResource` from `@plugins/primitives/plugins/live-state/web` — for the toolbar dot subscription.
- `@parcel/watcher` — already used by `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts`. Mirror its debounce-+-ceiling pattern (`scheduleRecompute` at lines 100-119).
- The room-pattern + `unsubscribes: Map<string, () => void>` from `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-resource.ts` — use only if v1 grows to per-ref dynamic subscriptions; not needed for the always-on `refs/heads/main` v1.
- `ensureMainWorktreeRoot` from `@plugins/infra/plugins/worktree/server` — *not* needed for the watcher (it uses `git rev-parse --git-common-dir`), but `getMainAheadCount` may still want it for `cwd`.
- `GIT` from `@plugins/infra/plugins/paths/server` — git binary path.

## Verification

1. **Build:** `./equin build` from this worktree — must regenerate `plugins-details.md` / `plugins-compact.md` (autogen check) and pass `./equin check`.
2. **Unit-level (manual):**
   - With server running, `touch` `refs/heads/main` (no SHA change): no notify should fire (sha guard).
   - Make a no-op commit on main locally (`git commit --allow-empty -m test` then move main): within ~100 ms the toolbar dot tooltip count should change without page reload, **and** the build should auto-run (toast appears, then `Build succeeded`).
   - Add a commit on main *without* trailers (`git commit -m "raw" --allow-empty`, fast-forward main): same as above — both dot and auto-build trigger. This is the regression case from the bug.
   - Stop the server, advance main by another commit, restart: startup catch-up should auto-build once; dot should reflect the new count immediately on first poll.
3. **Cross-surface:** `commits-graph` chip and `conversation-progress` are not changed by this plan, but the trigger event is now available for them to consume in a follow-up.
4. **Negative:** if `autoBuild` config is off, dot still updates (resource notify is independent of config), but no build runs (job early-returns). Confirm both behaviors.
5. **Reconcile:** simulate a missed event by killing the parcel subscription mid-flight (or just trust the 30 s reconcile interval in normal use). Within 30 s, any drift between the watcher's `lastKnownSha` map and reality should self-heal and emit if it differs.

## Out of scope

- Migrating `commits-graph` and `conversation-progress` to consume `refAdvanced` (separate follow-up; both currently subscribe to `pushesResource` which is correct for their domain).
- Multi-ref dynamic subscription via `onFirstSubscribe`/`onLastUnsubscribe` on `refHeadResource`. v1 only tracks `refs/heads/main`. The API supports more refs but no consumer needs them yet.
- Persisting `lastAutoBuildAt` across restarts (currently in-memory, only used for the toast — leave as-is).
- A periodic `git fetch origin main` job to surface remote-only commits. Out of scope per the explicit "watch local main only" goal.
