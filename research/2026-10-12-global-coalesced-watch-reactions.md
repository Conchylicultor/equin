# Coalesced watch reactions

## Context

On 2026-10-12, from about 16:28 to 16:55, main served a black screen. The edited-files watcher (`conversations/conversation-view/code/server/internal/watch-edited-files.ts`) did `void runTracked("watch-edited-files:recompute", …)` on **every** checkout-watch batch. Each recompute takes 4 git commands under the heavy-read gate, which has 2 slots and gets about 3.6 s per run under load. Recomputes arrived at about 2.7/s and the gate served about 0.5/s. The result was 3,291 queued runs, the oldest about 20 minutes stale. While they waited, they held all 6 read-admission slots, so the boot snapshot never answered.

There were two root causes:

1. **Nothing between a watch and its reaction bounds the work.** The engine (`infra/file-watcher/shared/engine.ts:flush`) calls `void runTracked(…, () => onChange(events))`. `dispatch` in `shared/registry.ts` only records the run. `acquireDirWatch` and `acquireCheckoutWatch` fan out synchronously. A callback that detaches async work gets one run per batch, with no limit.
   - A survey found 7 consumers with this shape: git-watcher recompute (it also races on `lastKnownSha`), edited-files, transcript-watcher (`debounceMs: 0`, a run per room per event), midi-folders, supervised-run, runtime-tmux session-files, and the `await` CLI.
   - It also found 3 hand-rolled `running`/`rerun` copies of the correct pattern (op-store, reports outbox, prototypes files).
   - corpus-index has a single-flight that **loses** the trailing run: `dirty = false` after an overlapping change.
   - Consumers that only call `notify()` are already bounded, because the resource runtime keeps one pending recompute per params tuple plus a `flushAgain` re-drain.
2. **The checkout watch forwards every ref in the shared `<common>/refs/`.** That means about 340 worktrees' commits, rebases and pushes reach every watched checkout. Edited-files reads only HEAD (and its branch), the index, the working tree, and `main`.

**Outcome:**
- A burst of events on a watched checkout with slow work gives at most **one running plus one pending** reaction per subscriber/key. A trigger that lands mid-run still gets a run afterwards.
- Other worktrees' ref updates reach no edited-files room.
- There is one shared mechanism, and the unbounded spelling is a lint error.

## Design

### 1. Primitive: `packages/coalesce` (core)

```ts
const c = createCoalescer<K, E>({ run: (key: K, items: E[]) => Promise<void> | void });
c.trigger(key, items?)  // void: start a run, or fold into the ONE pending run for the key
c.run(key, items?)      // Promise: resolves when a run that STARTED after this call settles
c.idle(key?)            // Promise: for tests and shutdown
```

**Semantics, per key:**
- While idle, `trigger` starts a run immediately.
- While a run is in flight, items accumulate into a single pending batch.
- When the run settles, the pending batch (if any) runs once.

**Guarantees:**
- At most one run and one pending batch per key.
- Pending memory is bounded by items, not by the number of triggers.
- A trigger never joins a run that started before it (unlike `createInflight`, which only joins).

**Failure:**
- A rejected run is rethrown into the drain chain, where it surfaces as an unhandled rejection, as today.
- `run()` callers covered by that run see the rejection.
- The pending batch still runs, so one failure never wedges the key.

**Counters:** each key records triggers, runs and folded batches. The watch catalog surfaces these (see §2).

**Keys:** an unkeyed form is just a single constant key, `createCoalescer({ run })` with `K = void`.

### 2. The watch layer delivers through it (the shared mechanism)

The handler type becomes `WatchReaction<E> = (events: E[]) => void | Promise<void>`. Its doc says to return the work's promise: the watch runs at most one reaction per subscriber at a time and folds the batches that arrive meanwhile into one trailing call.

It is applied at every point where a user callback is attached:

- **`shared/engine.ts`.** `flush` and the `debounceMs: 0` path call `changes.trigger(undefined, events)`. `onReconcile` gets its own coalescer: a tick while one is running becomes one pending tick. This covers both `defineFileWatcher` instances and the CLI's `watchForCommand`. The `runTracked("watch:<name>")` span now covers the awaited async work too.
- **`shared/registry.ts`.** `dispatch` returns the handler's promise instead of detaching it, so the engine's coalescer can await it. The run is still recorded. `FileWatcherSnapshot` gains `foldedBatches`, so the Background catalog shows coalescing at work.
- **`server/internal/dir-hub.ts`.** Each holder's `onChange` is wrapped in its own coalescer. The hub's native fan-out stays synchronous; only the subscriber's reaction is serialized.
- **`checkout-watch/server/internal/hub.ts`.** Each `acquire` listener is wrapped the same way.

Sync callbacks (`notify()`) pass straight through: a sync run settles at once, so nothing changes for the about 15 notify-only consumers.

### 3. Make the unbounded form unwritable

The new lint rule is `watcher-safety/no-detached-watch-reaction`. It is type-aware and keyed on the exported `WatchReaction` / `WatchReconcile` type aliases, not on callee names.

**What it flags:** a `void <expr>` whose operand is thenable, or a `.then(…)`/`.catch(…)` statement that is not returned, anywhere in a function whose contextual type is a watch reaction. Nested function bodies are not checked.

**The fix it suggests:** return or await the promise. For a per-key fan-out inside one batch (transcript rooms), use `coalescer.trigger(key)`, which is a synchronous `void`.

It goes in `watcher-safety/lint/index.ts`, next to `no-raw-fs-watch`, with a `.test.ts`.

### 4. Ref relevance in the checkout watch (problem 2)

The `acquireCheckoutWatch` options become required data, so every reader states which refs it reads (tsc enforces this):

```ts
acquireCheckoutWatch(root, { refs: { also: ["refs/heads/main"], upstream?: boolean }, onChange })
```

**What the hub classifies:**
- A git-area event under `<common>/refs/` (or `.git/refs/` for a main checkout) is classified as `{ area: "git", ref: "refs/heads/x" }`, with a `.lock` suffix stripped.
- HEAD, index and other git-dir files stay unrefined `git` changes.
- `packed-refs` counts as relevant to every reader. It is rare.

**What the hub tracks per root:**
- It tracks the checkout's **own branch**: the target of HEAD, read from `<gitDir>/HEAD` on open and re-read when a batch contains a HEAD change. The re-read is sequenced before that batch is forwarded, so a `git checkout b` plus the write to `refs/heads/b` is filtered against the new branch.
- With `upstream: true` it also tracks `@{u}`, resolved by one `git rev-parse --symbolic-full-name @{u}` on open and on HEAD change.

**Per-listener filter:** a ref change is kept only when its ref is the own branch, the upstream (if asked), or in `also`. A batch that ends up empty is not delivered.

**Readers:**
- Edited-files passes `{ also: ["refs/heads/main"] }`.
- File-explorer git status passes `{ also: [], upstream: true }`, because `--branch` reads ahead/behind.

Update `checkout-watch/CLAUDE.md` accordingly.

### 5. Migrate every consumer

Each watcher with the unbounded shape now **returns** its work, so the watch coalesces it.

| Consumer | Change |
|---|---|
| `conversation-view/code/.../watch-edited-files.ts` | `async (changes) => { if (all build output) return; await runTracked(…, () => recompute(room, emit)); }`, plus `refs` as in §4 |
| `infra/git/git-watcher/.../watcher.ts` | `onChange`/`onReconcile` return `recompute()`. This also removes the `lastKnownSha` interleaving. |
| `conversations/transcript-watcher/.../watcher.ts` | A keyed coalescer per room. `onChange` calls `rooms.trigger(room)` per room and the reconcile tick calls `trigger` for each room, so there is no cross-room head-of-line blocking. |
| `sonata/.../midi/folders/.../watcher.ts` | Return `onChange(events)` and `reconcile()` |
| `infra/jobs/supervised-job/.../supervisor.ts` | Return `onArtifactEvents(events)` and `reconcileSupervisedRuns()` |
| `conversations/runtime-tmux/.../signals.ts` (session files) | Return `onSessionFiles(events)` |
| `framework/cli/await/cli/run.ts` | Return `check()` |
| `infra/corpus-index/.../corpus-index.ts` | Replace `dirty` + `refreshInflight` with a coalescer. The watcher returns `c.run()`, and readers that need freshness `await c.run()`. This fixes the lost trailing run. |
| op-store `service.ts`, reports outbox `watcher.ts`, prototypes files `watcher.ts` | Delete the hand-rolled `running`/`rerun` flags in favour of the coalescer (prototypes keeps its `refresh()` callers via `c.run()`) |

Sync `notify()` consumers need no edit; they already go through the mechanism.

## Critical files

- **New:** `plugins/packages/plugins/coalesce/core/{index.ts,internal/coalesce.ts,internal/coalesce.test.ts}`
- **Changed:**
  - `plugins/infra/plugins/file-watcher/shared/{engine.ts,registry.ts}`
  - `server/internal/dir-hub.ts`, `CLAUDE.md`
  - `plugins/infra/plugins/git/plugins/checkout-watch/server/internal/{hub.ts,checkout-watch.ts}`, `hub.test.ts`, `CLAUDE.md`
  - `plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety/lint/{index.ts,no-detached-watch-reaction.ts,.test.ts}`
  - The consumers in §5
- **Reused:** `runTracked` (runtime-profiler) and `createRefcountHub`. `createInflight` is not reused, because it joins stale flights.

## Verification

1. **Coalescer unit test.**
   - Flood 1,000 triggers against a run gated on a deferred. Assert one running, at most one pending, and exactly 2 runs total.
   - Assert that a trigger after the first run starts produces a run that sees its items.
   - Assert that a rejection still drains the pending batch.
2. **Checkout-watch hub test** (`hub.test.ts`, which injects fake `acquireDirWatch`):
   - **Flood test (the exit criterion):** emit 500 batches at a listener whose reaction takes a slow deferred. Assert at most 1 concurrent plus 1 pending, and a final run after the last batch.
   - **Ref filter:** events on `refs/heads/other-wt` are dropped; `refs/heads/main` and the own branch are delivered; the own branch is re-resolved after a HEAD change.
3. **Engine and dir-hub tests:** a slow async `onChange` under rapid flushes is coalesced the same way, and so are reconcile ticks.
4. **Lint test:** `onChange: () => { void work(); }` errors; `onChange: () => work()` and `onChange: () => notify()` pass.
5. `./singularity test plugins/packages/plugins/coalesce plugins/infra/plugins/file-watcher plugins/infra/plugins/git/plugins/checkout-watch plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety`
6. `./singularity build`, which runs the checks, including type-check with the new lint rule over the whole repo.
7. **Live check:** open a conversation's code view, then `git commit --allow-empty` in a *different* worktree. `get_runtime_profile` (kind bg) should show no new `watch-edited-files:recompute`. An edit inside the watched worktree still updates the list.

## Out of scope (separate tasks)

These are noted in the incident: read-admission holding all slots while waiting, read deadlines, and the blank-screen-on-boot-snapshot failure. Edited-files also still recomputes on changes in git-ignored paths outside build output, such as a main checkout's `.claude/worktrees/**`. That is now bounded, but it could be filtered with an ignore index as file-explorer does; file it as a follow-up.
