---
name: Worktree fs-watch primitive
description: Central fs-watch service that replaces the per-conversation edited-files poller and the phase-indicator sweep with a single event-driven git-state cache shared by all consumers.
---

# Worktree fs-watch primitive

## Context

Two timers currently scan every worktree for git changes:

1. `edited-files-resource.ts` — 1 s `setInterval` **per subscribed conversation** calling `getEditedFiles` (two git processes per tick).
2. `phase-watcher.ts` (planned in `2026-04-15-conversations-phase-indicator.md`) — 2 s sweep over **all active conversations**, again calling `getEditedFiles` for each.

Both are redundant: they ask git the same question ("what changed in this worktree vs main?") on a fixed cadence, regardless of whether anything happened. That burns CPU during idle periods and introduces up to 1–2 s of UI lag when a file is saved. As more plugins need edit-awareness (file tree, build-button dirty indicator, agent "idle" detection), adding more pollers scales badly.

This plan introduces a single **event-driven** primitive — a per-worktree filesystem watcher that invalidates a shared `EditedFile[]` cache when something on disk changes. Both existing consumers migrate onto it, and future consumers subscribe without adding new timers.

### Design principle

> **fs events are the *trigger*, git is the *truth*.**

We do **not** reimplement git's diff logic from raw fs events, and we do **not** parse `.gitignore` ourselves for correctness. When an event arrives, we invalidate the cache and re-run `getEditedFiles` (which already shells out to git). Gitignore parsing is only used as a performance filter to stop watching noisy directories (`node_modules`, etc.) — correctness still comes from git.

This principle is what makes the design safe. The watcher can be wrong (miss an event, over-fire) and we still converge to the correct state on the next event or the per-worktree force-recompute ceiling (see §Debounce).

## Library choice

Recommend **`@parcel/watcher`**.

| Option | Pros | Cons |
|---|---|---|
| **`@parcel/watcher`** (recommended) | Native (FSEvents / inotify / ReadDirectoryChangesW). Handles atomic writes, renames, `.gitignore` out of the box via `ignore` option. Used by Vite, Parcel, Rspack. | Native dep (prebuilt binaries exist for macOS/Linux/Windows). |
| Built-in `fs.watch({ recursive: true })` | Zero deps. | Recursive is reliable only on macOS and Windows; Linux is emulated and leaks watches. No ignore support — you have to filter paths after-the-fact, after the watcher has already opened `node_modules`. |
| `chokidar` | Mature, flexible. | JS wrapper + polling fallback, higher CPU, bigger dep tree, slower startup. |
| Bun's native watcher | Aligned with runtime. | Currently non-recursive / lacking ignore support. |

`@parcel/watcher` lets us pass `ignore: ["**/node_modules/**", "**/.git/**", ...]` at subscription time, which prevents the native backend from ever registering watches on those directories — critical for avoiding inotify exhaustion on Linux and event floods during `bun install`.

## Architecture

### Module

New file: **`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts`**

It lives inside the `code` plugin alongside `get-edited-files.ts` and `edited-files-resource.ts`, not in `conversations/server/internal`. The watcher knows about worktree paths and git diffs — it has no notion of conversations. The `code` plugin is the existing owner of edit-awareness (edited files, file viewer, edited-files button), so this primitive is an implementation detail of that plugin. Placing it higher up would force consumers in the `code` layer to reach sideways into `conversations/internal`.

The entire public surface is **one function**:

```ts
// Subscribe to edited-files updates for a worktree. The callback fires
// whenever the working tree's git-diff-vs-main changes (debounced). Returns
// an unsubscribe function. Last unsubscribe closes the native watcher.
export function watchEditedFiles(
  worktreePath: string,
  onChange: (files: EditedFile[]) => void,
): () => void;
```

Design notes:

- **Refcount is implicit**: first subscriber for a path opens the native watcher; last unsubscribe closes it. No `ensure` / `release`.
- **Keyed on path, not conversation id**: the watcher doesn't know about conversations. Callers do the `id → path` lookup before subscribing.
- **No `snapshot()` accessor**: callers that need a sync read either remember the last value they got from `onChange`, or call `getEditedFiles(path)` directly — a few-ms git diff is fine on demand. See §Consumer migration for how `editedFilesResource.loader` uses this.
- **Idempotent per-subscriber**: the same `(path, onChange)` subscribed twice still counts as two refs. Callers own their unsubscribe handles.

### Internal state per worktree path

Private to the module:

```ts
interface Room {
  worktreePath: string;
  subscription: parcel.AsyncSubscription | null;   // native watcher handle
  serialized: string;                               // last JSON.stringify(files), for no-op de-dup
  debounceTimer: Timer | null;
  lastRecomputeAt: number;
  subscribers: Set<(files: EditedFile[]) => void>;
}
```

Refcount = `subscribers.size`.

### Event loop per worktree path

1. **On first subscriber**: call `getEditedFiles` once to seed `serialized`, fire the new subscriber's `onChange` with that initial list, then start the native watcher.
2. **On subsequent subscribers**: fire their `onChange` with the last known list; no extra git invocation.
3. **On fs event** (any path inside the worktree, after ignore filtering): schedule a trailing debounce (200 ms).
4. **On debounce fire**: call `getEditedFiles`. If `JSON.stringify(files)` differs from cached `serialized`, update it and fan out to all `subscribers`. Otherwise drop silently.
5. **Ceiling**: if events keep arriving continuously, force a recompute every 2 s regardless (matches current polling ceiling so freshness never gets worse than today).
6. **On last unsubscribe**: close the native subscription and delete the room.

### Ignore list

Hardcoded, applied at `parcel.subscribe({ ignore })`:

```
**/.git/**
**/node_modules/**
**/dist/**
**/build/**
**/.next/**
**/.turbo/**
**/.cache/**
**/coverage/**
```

These directories are either git-ignored or git-internal; filtering them pre-watcher saves native handles and event load. Git itself is still the source of truth for which of the remaining events correspond to actual "edited files."

We intentionally do **not** parse nested `.gitignore` files — the hardcoded list covers 99 % of the event volume, and any miss still produces correct UI (just a few extra re-runs of `getEditedFiles`, which returns the right answer regardless).

### Debounce semantics

- Trailing 200 ms per worktree.
- Hard ceiling of 2 s between recomputes even during continuous bursts.
- Co-alesces a typical `bun install` (thousands of events) into one recompute per burst-quiet-window.

### Retention for terminal conversations

Terminal conversations (`completed` / `gone` / `abandoned`) stop producing fs events and their phase is determined by whether a push exists — their edited-files list is no longer load-bearing. The phase-watcher simply unsubscribes when a conversation goes terminal; the native watcher closes. The phase icon stays stable because it's computed from a final `hasPush` check, not from live file state.

## Lifecycle integration

The watcher itself has no lifecycle integration — it's a pure function keyed on a worktree path, with no awareness of conversations. Lifecycle is each **consumer's** problem:

- `editedFilesResource` (inside `code`): subscribes on `onFirstSubscribe`, unsubscribes on `onLastUnsubscribe`. That's it — the resource's existing lifecycle already handles everything.
- Phase plugin (designed separately): subscribes per active conversation at boot and on create, unsubscribes on terminal transition and on delete. Owns its own `Map<id, Unsubscribe>`.

No bespoke `ensure`/`release` plumbing in the watcher, and no need for `conversations/internal` to know that watchers exist.

## Consumer migration

### `editedFilesResource`

File: `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-resource.ts`

Replace the `setInterval` + `rooms` map with a subscribe call:

```ts
const unsubscribes = new Map<string, () => void>();

export const editedFilesResource = defineResource({
  key: "edited-files",
  mode: "invalidate",
  loader: async ({ id }: Params) => getEditedFiles(worktreePathForSync(id)),
  onFirstSubscribe({ id }: Params) {
    unsubscribes.set(
      id,
      watchEditedFiles(
        worktreePathForSync(id),
        () => editedFilesResource.notify({ id }),
      ),
    );
  },
  onLastUnsubscribe({ id }: Params) {
    unsubscribes.get(id)?.();
    unsubscribes.delete(id);
  },
});
```

The `loader` calls `getEditedFiles` directly — the watcher is only responsible for *when* to invalidate, not *what* data to return. If the extra git-diff on loader ever shows up in profiles, a private `lastFiles: Map<path, EditedFile[]>` can be added inside the watcher module with a non-exported fast-path reader; no API change needed.

### `phaseWatcher`

File: `plugins/conversations/server/internal/phase-watcher.ts` (per `2026-04-15-conversations-phase-indicator.md`)

Replace the 2 s sweep with a permanent subscription per active conversation:

```ts
const tracked = new Map<string, () => void>();

function trackConversation(id: string, path: string) {
  const unsub = watchEditedFiles(path, (files) => {
    const phase = computePhase(files, hasPush(id));
    if (phase !== lastPhase.get(id)) {
      lastPhase.set(id, phase);
      conversationsResource.notify();
    }
  });
  tracked.set(id, unsub);
}

function untrackConversation(id: string) {
  tracked.get(id)?.();
  tracked.delete(id);
}
```

The phase indicator now updates reactively: a `research/plan.md` save → parcel event → 200 ms → phase flips to **design** on the sidebar. Same flow for review.

### Push-watcher (unchanged, noted)

`push-watcher.ts` polls `main`'s git ref on a 1 s tick. Could be migrated to fs-watch on `.git/refs/heads/main` + `.git/packed-refs`, but it's already cheap (one `rev-parse`) and correctness matters more than freshness there. **Out of scope** — noted as a possible follow-up.

## Failure modes & handling

| Failure | Handling |
|---|---|
| Worktree path doesn't exist yet on `ensure` | Retry with backoff (100 ms, 500 ms, 2 s, then give up and log). `setupWorktree` completes before `ensure` so this should be rare. |
| Native watcher errors (backend crash, path deleted) | `parcel` surfaces via error event → log, close room, schedule re-open after 1 s. If the path is now gone (conversation deleted), skip reopen. |
| `getEditedFiles` throws (git not installed, corrupt repo) | Log, keep previous snapshot, retry on next debounce. |
| inotify exhaustion on Linux (`ENOSPC`) | Ignore list eliminates `node_modules`, which is the main culprit. If still hit, log a clear message pointing at `/proc/sys/fs/inotify/max_user_watches`. |
| Two conversations claim the same worktree path | Shouldn't happen by construction (`setupWorktree` creates a fresh dir per id), but the rooms map keys on conversation id, not path, so they just get independent watchers on the same path. Acceptable. |

## Files to create / modify

- **Create** `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts` — exports `watchEditedFiles` only
- **Edit** `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-resource.ts` — replace `setInterval` with `watchEditedFiles`
- **Phase-watcher placement** (decided in the phase-indicator plan, not here) — it consumes `watchEditedFiles` from the `code` plugin and reads `pushes` from the `conversations` layer; likely a new nested plugin `code/plugins/phase/` rather than `conversations/server/internal/phase-watcher.ts`. The lifecycle hooks (create/terminal/delete) then live inside that phase plugin, not in `conversations/internal`.
- **Edit** root `package.json` — add `@parcel/watcher`

## Verification

1. `./equin build` — installs `@parcel/watcher`, rebuilds server.
2. **Freshness**: open the app, open a conversation, edit a file in its worktree from the CLI (`echo x >> file.ts`). The edited-files panel should update within ~300 ms (previously up to 1 s).
3. **Phase flip**: create a conversation, write `research/foo.md` — sidebar icon flips to **design** within ~300 ms. Edit a non-research file — flips to **review**.
4. **Idle CPU**: leave 10 conversations open with no activity; `top` should show the server process near 0 % CPU (previously ≥ N × 1 Hz of git invocations).
5. **Burst behaviour**: run `bun install` in a worktree; verify:
   - no CPU spike lasting more than 2–3 s after the burst ends
   - edited-files recomputes fire at most once per 200 ms quiet window + once per 2 s ceiling
   - no log spam
6. **Lifecycle**: create a conversation, delete it; confirm the watcher closes (`lsof -p <server> | grep <worktree>` returns nothing for that path).
7. **Server restart with N active conversations**: restart, count watchers via `lsof`; should equal the number of active conversations. No leaks after repeated restarts.
8. **Linux (when relevant)**: on a Linux host, `cat /proc/<pid>/fdinfo/<inotify-fd>` shows a bounded number of watches even with large worktrees, thanks to the ignore list.

## Out of scope / follow-ups

- **Push-watcher migration** to fs-watch on `.git/refs/heads/main`.
- **Per-file subscriptions** (e.g. `FilePane` subscribing only to a specific path). Easy extension: add a `path` filter argument to `subscribe`. Design accommodates this but we don't need it yet.
- **Multi-process server**: if the server ever runs multi-process, watchers will need to shard by conversation id. Not a concern today.
- **Gitignore-aware nested filtering**: if the hardcoded ignore list proves insufficient in practice (e.g. someone's project dumps huge generated files into a non-obvious dir), we can add a lightweight `.gitignore` parser via the `ignore` npm package. Defer until observed.
