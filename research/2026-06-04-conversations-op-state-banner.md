# Surface build/push/lock operation state in the conversation view

## Context

When a build or push is running for a conversation's worktree, the conversation
UI only shows the generic "working" status. There is no way to tell whether the
agent is actively thinking or a build/push is in progress — nor whether a push
is **queued behind another push**, waiting on the global push lock (which can be
several minutes). This exact gap recently made a running push look like it was
just "waiting".

The server already tracks the data: a per-worktree filesystem op-marker at
`~/.singularity/worktrees/<slug>/ops/{build,push}.json` holds
`{ op, pid, startedAt }`, written before the work starts and cleared on exit.
The conversation poller reads it (via `isWorktreeOpActive`) to compute the
boolean "working" status, but the marker detail is never exposed to the client.

**Goal:** render a banner in the conversation view (above the prompt input)
showing the live operation: "Push in progress" / "Build in progress" /
"Push queued — waiting for lock", each with a live-ticking elapsed timer.

**Decisions (confirmed with user):**
- The waiting-for-lock vs running phase distinction covers **pushes only**.
  Build shows a plain "Build in progress". The marker `phase` field is generic,
  so build-lock-wait can be added later with no schema change.
- Elapsed time renders as a **live ticking `mm:ss`** (1s display ticker; the op
  *state* remains push-driven — the ticker only re-renders the clock).

## Design

Two precedents are copied byte-for-byte:

1. **`git-watcher`** (`plugins/infra/plugins/git-watcher/server/internal/watcher.ts`)
   — watches files via `createFileWatcher` and calls `resource.notify()` on
   change. Push-based, no polling. We watch the op-marker directory the same way.
2. **`turn-summary`** (`plugins/conversations/plugins/conversation-view/plugins/turn-summary/`)
   — a self-contained sub-plugin under `conversation-view` that declares a global
   push resource (keyed map), contributes a component to
   `Conversation.AbovePromptInput`, and looks up its own conversation's entry.
   Our new plugin mirrors its file layout exactly.

The op marker stays owned by the `worktree` plugin (the data primitive). A new
`op-status` sub-plugin owns the live-state resource, the file watcher, and the
banner — its only cross-plugin dependency is `@plugins/infra/plugins/worktree/server`.

### 1. Extend the op-marker primitive (worktree plugin)

**File:** `plugins/infra/plugins/worktree/server/internal/worktree-op.ts`

- Add `export type WorktreeOpPhase = "waiting-for-lock" | "running";`
- Add `export interface WorktreeOpInfo { slug: string; op: WorktreeOp; startedAt: string; phase: WorktreeOpPhase; }`
- Change signature:
  `markWorktreeOpStart(slug, op, phase: WorktreeOpPhase = "running")` — include
  `phase` in the written JSON. Default `"running"` keeps `build.ts` unchanged.
- Add `setWorktreeOpPhase(slug, op, phase)`: read the existing marker, rewrite it
  preserving `pid`/`startedAt` with the new `phase` (no-op if the file is gone).
- Add `listActiveWorktreeOps(): WorktreeOpInfo[]`: scan
  `~/.singularity/worktrees/*/ops/*.json` across **all** worktrees, run the same
  pid-liveness check as `isWorktreeOpActive` (reaping dead/garbage markers),
  return live ones parsed into `WorktreeOpInfo`. Treat a missing `phase` as
  `"running"` (back-compat with markers written before this change).
- Export a watch-root accessor `worktreesDir(): string` (returns
  `join(SINGULARITY_DIR, "worktrees")`) so the path stays owned here.
- Refactor the per-marker liveness/parse logic into a small shared helper used by
  both `isWorktreeOpActive` (unchanged behavior) and `listActiveWorktreeOps`.

**File:** `plugins/infra/plugins/worktree/server/index.ts` — export
`setWorktreeOpPhase`, `listActiveWorktreeOps`, `worktreesDir`, and the
`WorktreeOpPhase` / `WorktreeOpInfo` types.

> The conversation poller's existing `isWorktreeOpActive` call (in
> `runtime-tmux`) is **unchanged** — this adds a new surface, it does not replace
> the "working" status path.

### 2. Record the lock-wait phase in the push CLI

**File:** `plugins/framework/plugins/cli/bin/commands/push.ts`

- Import `setWorktreeOpPhase` alongside the existing `markWorktreeOpStart` /
  `clearWorktreeOp`.
- Line ~283: `markWorktreeOpStart(opSlug, "push", "waiting-for-lock")` (the marker
  is already written before the lock wait — now it starts in the waiting phase).
- In the `withPushLock(..., onLockRequested, onLockAcquired)` call, inside the
  existing `onLockAcquired` hook (~line 285), add
  `setWorktreeOpPhase(opSlug, "push", "running")`. When there is no contention
  the transition is instantaneous (banner shows "in progress" immediately); when
  a push is queued, it stays "waiting for lock" until the lock is granted.

`build.ts` is untouched (its `markWorktreeOpStart(name, "build")` now defaults to
`phase: "running"`).

### 3. New `op-status` sub-plugin (mirrors `turn-summary`)

**Dir:** `plugins/conversations/plugins/conversation-view/plugins/op-status/`

```
shared/
  schemas.ts   — WorktreeOpSchema, WorktreeOpsPayloadSchema (record slug→op),
                 worktreeOpsResource (resourceDescriptor, key "worktree-ops")
server/
  index.ts     — Resource.Declare(worktreeOpsResource) + onReady/onShutdown
  internal/
    resource.ts — defineResource({ key: "worktree-ops", mode: "push", loader })
                  loader builds a { [slug]: WorktreeOpInfo } map from
                  listActiveWorktreeOps()
    watcher.ts  — createFileWatcher({ dirs:[worktreesDir()], extensions:[".json"],
                  onChange: () => worktreeOpsResource.notify(),
                  onReconcile: () => worktreeOpsResource.notify() })
                  start/stop helpers; mkdirSync(worktreesDir(),{recursive:true})
                  before subscribe so boot never throws on a missing dir.
web/
  index.ts                    — contributes Conversation.AbovePromptInput → OpStatusBanner
  components/op-status-banner.tsx — the banner
```

- **`shared/schemas.ts`**: `WorktreeOpSchema = z.object({ slug, op: z.enum(["build","push"]), startedAt: z.string(), phase: z.enum(["waiting-for-lock","running"]) })`;
  `WorktreeOpsPayloadSchema = z.record(z.string(), WorktreeOpSchema)`;
  `worktreeOpsResource = resourceDescriptor<WorktreeOpsPayload>("worktree-ops", WorktreeOpsPayloadSchema, {})`.
  (Same key string is reused by `defineResource` server-side — exactly the
  turn-summary two-halves pattern.)
- **`server/internal/resource.ts`**: `defineResource` whose loader maps
  `listActiveWorktreeOps()` into `{ [slug]: info }`.
- **`server/internal/watcher.ts`**: copy of `git-watcher/watcher.ts` shape —
  module-level `watcher`/`started` guards, `startOpWatcher()` / `stopOpWatcher()`,
  watching `worktreesDir()`; every change/reconcile calls
  `worktreeOpsResource.notify()` (the loader re-reads the filesystem).
- **`server/index.ts`**: `contributions: [Resource.Declare(worktreeOpsResource)]`,
  `onReady: startOpWatcher`, `onShutdown: stopOpWatcher`.
- **`web/components/op-status-banner.tsx`** (props `{ conversation }`, like
  `TurnSummaryCard`):
  - `slug = conversation.worktreePath.split("/").filter(Boolean).pop()` (matches
    the poller's `basename(worktreePath)` keying — avoid `node:path` in browser).
  - `const result = useResource(worktreeOpsResource); if (result.pending) return null;`
  - `const op = result.data[slug]; if (!op) return null;` (common case → no banner;
    `showBottomBar` is already true via prompt-input/turn-summary).
  - Label: `push`+`waiting-for-lock` → "Push queued — waiting for lock" (warning
    tone); `push`+`running` → "Push in progress"; `build` → "Build in progress".
  - **Elapsed**: a tiny `useNow(1000)` ticker (local `setState` on a 1s interval,
    cleared on unmount) computes `mm:ss` from `op.startedAt`. This is a
    presentational clock only — the op state is push-driven, so it is not a
    state-polling loop. Render e.g. `Push in progress · 1:23`.
  - Reuse the `<Spinner />` primitive (`@plugins/primitives/plugins/spinner/web`)
    or an `MdSync`/`MdHourglassEmpty` icon, styled like `TurnSummaryCard`
    (`rounded-md border bg-muted/30 px-3 py-2 text-xs`); warning tone for the
    queued phase.

### Boundary / rules check

- Cross-plugin imports: `op-status/server` imports
  `listActiveWorktreeOps` / `worktreesDir` from `@plugins/infra/plugins/worktree/server`
  and `createFileWatcher` from `@plugins/infra/plugins/file-watcher/server` — both
  legal runtime-barrel imports. `web` imports `Conversation` /
  `ConversationRecord` from `@plugins/conversations/plugins/conversation-view/web`
  (same as turn-summary).
- `worktreeOpsResource` descriptor lives in `op-status/shared` and is imported by
  this plugin's own `web` and `server` (relative paths) — never cross-plugin
  (identical to turn-summary's `turnSummariesResource`).
- No `id:` in barrels (loader-injected). Barrels stay pure (imports + single
  `export default`).

## Files to create / modify

Modify:
- `plugins/infra/plugins/worktree/server/internal/worktree-op.ts` — phase field, `setWorktreeOpPhase`, `listActiveWorktreeOps`, `worktreesDir`, shared liveness helper
- `plugins/infra/plugins/worktree/server/index.ts` — new exports
- `plugins/framework/plugins/cli/bin/commands/push.ts` — `waiting-for-lock` → `running` transition

Create (new `op-status` sub-plugin):
- `.../conversation-view/plugins/op-status/shared/schemas.ts`
- `.../conversation-view/plugins/op-status/server/index.ts`
- `.../conversation-view/plugins/op-status/server/internal/resource.ts`
- `.../conversation-view/plugins/op-status/server/internal/watcher.ts`
- `.../conversation-view/plugins/op-status/web/index.ts`
- `.../conversation-view/plugins/op-status/web/components/op-status-banner.tsx`
- `.../conversation-view/plugins/op-status/CLAUDE.md` (hand-written prose; autogen block filled by build)
- `package.json` files as required by the workspace convention (copy from `turn-summary`)

## Verification

1. `./equin build` (regenerates docs/registry, restarts server).
2. `./equin check` — boundaries, migrations-in-sync, plugins-doc-in-sync.
3. Open a conversation at `http://<worktree>.localhost:9000/c/<id>`.
4. **Build banner**: trigger `./equin build` for that worktree; confirm
   "Build in progress · m:ss" appears above the prompt input with a ticking timer,
   and disappears when the build finishes.
5. **Push running banner**: run a push for that worktree; confirm "Push in
   progress" with elapsed time.
6. **Push queued phase**: start one push to hold the global lock, then start a
   second push from another worktree's conversation; confirm the second shows
   "Push queued — waiting for lock", then flips to "Push in progress" once the
   first releases the lock. (`query_db` can confirm nothing else regressed; the
   marker files under `~/.singularity/worktrees/<slug>/ops/` can be inspected
   directly to confirm the `phase` field flips.)
7. Confirm the banner is absent (no layout shift / empty box) when no op is
   running, and that the existing turn-summary card still renders alongside it.
```
