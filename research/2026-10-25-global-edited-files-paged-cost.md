# edited-files: remove the cost the paged, pushed value pays

Plugins: `conversations/conversation-view/code`, `infra/git/git-read-cache`, `packages/watched-memo` (new), `infra/file-watcher`, `infra/git/checkout-watch`, `infra/query-resource`, `framework/resource-runtime`, `network/live`, `tasks/tasks-core`, `debug/slow-ops`.
Follows: `research/2026-10-22-global-live-bounds-independent-of-freshness.md` (B3).

## Context

B3 (0e3c207c6a) made `edited-files` a key-range paged pushed value (pages + `:meta`, sibling `edited-files.file`), all slicing one `createSignedMemo`. Opening a review pane raised a ~1.6 s slow-op toast (494-file worktree). Investigation (two workflows, adversarially verified; trace 877f8c96 on main) found:

**Where the time goes.** The cost is `git status --porcelain -uall`: 0.6–1 s, from walking about 7.5k untracked dirs, even on a clean tree. `-C` and heavy-slot queueing are noise. Each review-pane open runs it **5×**:
- `git-state-memo.ts:76` probes the signature on *every* `get`, before the single-flight. The pages loader, the meta loader and the watcher baseline therefore make 3 concurrent probes.
- `computeEditedFiles` runs its own `status` (`compute-edited-files.ts:98`) after `merge-base` and two diffs, all sequential.
- The memo re-probes after the compute (`git-state-memo.ts:101`).
- On the WS path, `whileSubscribed` (DB lookup + `acquireCheckoutWatch`) is awaited before any loader runs: about 160 ms.

**Rate.** Two triggers re-run the loaders:
- **A worktree change.** The watcher recompute does signature + `computeEditedFiles` **directly** (bypassing the single-flight) + signature (`watch-edited-files.ts:111-115`). Its notify then re-runs page + meta, each with a full probe, inside the server-wide serialized flush (`runtime.ts:5282-5325`).
- **Any conversations/attempts write** (every agent turn). The pages' reads compile to *whole* relation reads (`compiledKeyedReads`, `query-resource/.../routes.ts:374`, D31), and the meta's to full routes over every column (`compiledValueReach`). There is no column gate, so page + meta + probe re-run each time. Main's op-rate monitor shows `push deliver:edited-files` at 83 s/window against a 30 s budget, holding the flush mutex that every other key's delivery waits on.
- The memo is evicted on last unsubscribe (`watch-edited-files.ts:47`), so every reopen is cold.

**"Not slow before" is only partly true.**
- Old on-demand reads already raised element slow-ops daily: 5825 samples, median 1.39 s, 26–54 reports/day.
- What B3 added:
  - pages + `:meta` give two fingerprints per open;
  - a pushed `update` signal;
  - loaders now run inside the flush, fired by watcher and table writes.
- The reported toast (att-1792672830-it60fm, 04:36Z) was 1609 ms of `server-deliver`, alongside four other keys stalled in the same flush at load 25.

**The `reads` belief is wrong.** A paged value *does* declare static `reads` (`PagedReadsOption`, `serve-value.ts:164`). `editedFilesServed` passes `READS`, and the guard's `readCovered` accepts it. No drift or undeclared-read report exists on main or in worktree logs. The real problem is the opposite: the declaration is whole-table and ungated, which drives the fan-out above.

`review/plugin-changes` is excluded from the composition (`compositions.origin.jsonc:22`), so it is not a factor. It must keep type-checking.

Bug found on the way: `compute-edited-files.ts:98-105` parses non-`-z` porcelain, so C-quoted paths (space, quote, non-ASCII) mismatch the diff paths and their untracked line counts read 0.

**Outcome:**

| Event | Today | After |
|---|---|---|
| Open | 5 status scans + whileSubscribed | 1 status scan; warm watched = no git spawn |
| Worktree change | 3 scans + 2 probes per tuple | 1 pass (1 status + diffs), loaders are O(1) slices |
| conversations/attempts UPDATE | page + meta + probe per subscribed tuple | 0 re-runs |
| Toast | one report row per conversation × (pages, meta) | one per resource key |

## Design

### 1. `createWatchedMemo` — the watch is the freshness authority (packages/watched-memo, new)

A pure core primitive beside `coalesce` / `refcount-hub`, with no git in it (everything is injected). It makes the faults seen here impossible to write:
- There is no `prime`, so a hand-ordered prime cannot exist.
- The watcher *is* the memo, so it cannot bypass the single-flight.
- Compute takes the probe's facts, so it cannot re-read status.

```ts
createWatchedMemo<T, F>({
  name,
  facts: (key) => Promise<F>,                      // what compute needs and the signature reads
  signatureOf: (key, facts: F) => Promise<string>, // only on the unwatched path
  compute: (key, facts: F) => Promise<T>,
  changes: (key, trigger: (resync?: true) => void) => Promise<() => void>, // resolves once live, rejects if unwatchable
  equals?: (a: T, b: T) => boolean,                // default: JSON equality
}): { get(key): Promise<T>; watch(key, onChange): Promise<() => void>; evict(key): void }
```

**Watched mode.** A refcount hub per key. `open` awaits `changes(key, trigger)` and then triggers pass 1. Passes run through `createKeyedCoalescer`: one at a time, with mid-run triggers folded into one trailing pass. Per-key state is `opening{first}` | `watched{value}` | `demoted`.

**`get`:**
- *watched*: return the value, with no probe and no spawn (marker `memo-watched-hit:<name>`).
- *opening*: await `first`.
- *demoted* or *unwatched*: the probe path (below).
- `first` rejects, and the get falls through to the probe path, when `changes` rejects, when pass 1 fails, or when the last holder leaves before pass 1 settles.

**`pass`:** `f = facts(key)`, then `v = compute(key, f)`. **Every pass computes; nothing is skipped on an equal signature.** A signature skip would bring back stale-forever: a write read mid-pass and then undone on a clean file returns the signature to S0 while the value still shows the write.
- Pass 1 sets the value and resolves `first` without notifying.
- A later pass keeps the held object (identity) and does not notify when `equals`; otherwise it sets the value, then notifies.
- On a closed room it writes nothing.
- On *any* error it sets `demoted` and notifies, and does not rethrow (a rethrow would be an unhandled rejection in the coalescer). The loader's probe path then re-raises the real error loudly (gone → `unresolved`, anything else → loader error). The next successful pass restores `watched`.
- Close deletes the entry. There is no warm-on-close: a late debounced event after a "clean" pass makes it unsound, and a reopen is one pass anyway.

**Probe path** (unwatched or demoted): `facts` → `signatureOf` → hit, or a single-flight compute keyed by `key\0sig` that **receives the probe's facts** (one status scan per miss, not two). It keeps the post-compute re-probe before caching, the same as `git-state-memo.ts:89-125`.

**Freshness argument** (replacing probe-on-get): every write git can see, made after the watch is live, yields a checkout-watch event delivered after it. *As landed:* that needed checkout-watch to hear, for a linked worktree, the common dir's `config`, `packed-refs` and `info/` beside its refs (a one-level watch of the common dir, filtered, plus `info/`); the inputs outside the repo — the global excludes file and global config — stay unheard, a stated exception.
- Pass 1 starts after the watch is live.
- A change during or after a pass triggers a trailing pass.
- The value is set before the notify.
- So readers see value N or newer, with staleness bounded by one in-flight pass. This is safe because pushes carry values: there is no ETag left to pin a stale value (B3 deleted `revalidate`; document that re-adding one requires returning the entry's own signature).

`createSignedMemo` / `createGitStateMemo` and their other callers are untouched (jsonl-events and subagents still use `prime`, file-explorer git-status still uses `revalidate`).

### 2. Lost-events signal (infra/file-watcher → dir-hub → checkout-watch)

The memo now depends on the watch alone. Today a parcel/FSEvents error is only `console.error` (`file-watcher/shared/engine.ts:337-339`), and a dropped event was healed by accident by probe-on-get. Plumb the error as a push signal:
- `engine` calls `onLost(dir)` with the error;
- dir-hub fans it out to every holder of that root;
- checkout-watch delivers it as a `resync` to every reader;
- the watched memo turns it into a trigger.

No timer. The error is still logged (fail loudly).

### 3. edited-files on the watched memo, one git pass per change (conversation-view/code)

- `edited-files-signature.ts` splits into `readEditedFilesFacts(wt)`, which runs `merge-base main HEAD` ‖ `status --porcelain --no-renames -uall -z` → `{ mergeBase, dirty }`, and `editedFilesSignatureOf(wt, facts)`, which adds `rev-parse HEAD` + lstat per dirty entry → `editedFilesEtag`. `editedFilesSignature(wt)` stays, composed from the two (`plugin-tree-cache.ts:76`). The module stays a leaf.
- `computeEditedFiles(wt, facts)` drops its own merge-base and status. It derives untracked/added/deleted from `facts.dirty` (`-z`-parsed via `parsePorcelainZ`, which **fixes the quoting bug**). It merges the two diffs into one `git diff -M -C -z --raw --numstat <base>`: raw records come first, then numstat, with renames as `0\t0\t\0from\0to` (layout verified with real git). That needs a new `parseDiffRawNumstatZ` in `primitives/commit-list` beside `parseDiffNameStatusZ`. The compute stays inside `withHeavyReadSlot`.
- `edited-files-cache.ts`: `editedFilesMemo = createWatchedMemo({ name: "edited-files", facts, signatureOf, compute, changes: (wt, trigger) => acquireCheckoutWatch(wt, { refs: { also: ["refs/heads/main"] }, onChange: trigger, onResync: () => trigger(true) }) })`. Delete `primeEditedFiles`.
- `watch-edited-files.ts` shrinks to `editedFilesMemo.watch(wt, onChange)`, keeping the WorktreeGone → no-op-stop mapping and `runTracked("watch-edited-files:pass")` attribution. Delete Room / baseline / recompute.
- `edited-files-resource.ts`: `onWorktree` keeps its gone → `unresolved` branch; its evict touches only the unwatched cache.

### 4. Reads that the change feed gates: compiled lookups (query-resource, resource-runtime, network/live, tasks-core)

The goal is that a conversations/attempts UPDATE reaches no edited-files tuple, without a hand-kept column list. Routes are minted, never written (`routing.ts:262-272`), and the drift guard sees tables, not columns.

- **`compileLookup`** (`query-resource/server/internal/compile-lookup.ts`, new; built on the existing point/join compilers `spec.ts` `PointQueryResourceSpec`, `joins.ts` `compileJoins` / `routeColumnsOf`):
  - `compileLookup({ label, from, by: { column, param: (p) => string | null }, joins, select, row })` → `{ run(p), read: LookupRead<P> }`.
  - The SQL and the per-table columns (select ∪ join keys ∪ by-column) come from one spec. `match` on the from-table key comes from `param(p)`; a null param means no match.
  - `run`'s DB captures are tagged with the lookup's label.
- **`ValueReads<P = ResourceParams>`** gains `lookups?: readonly LookupRead<P>[]`.
  - `compiledValueReach` mints one *gated* full route per lookup table, with a per-tuple match.
  - It refuses a table listed in both `tables` and `lookups`.
  - The drift guard counts a lookup-only table as covered *only* by captures carrying that lookup's label. That closes column drift at rung 3/4.
  - `compiledKeyedReads` is deleted.
- **resource-runtime**:
  - `ExternalWindowPolicy` / `ExternalPointPolicy` take `reach?: ReachPlan<P>` in place of `relations` / `unfed`.
  - `routingRecordFor` relaxes its "reach is the non-keyed arm" refusal (~3719) *only* for an external window or point, keeping the every-route-full assert (~3724), and folds `externalKeyedRouting` (~2964) into it.
  - D31 becomes "never scoped; may take a full-only reach plan" (resource-runtime `CLAUDE.md` 147-175).
  - The change-feed trigger derives its `unchanged` gate from narrowed routes automatically (`triggers.ts:556-590`, `runtime.ts:8163`).
- **network/live** `serve-value.ts:505-517`: the keyed branch passes `reach: compiledValueReach(reads, label)` like every other arm. Update the `PagedReadsOption` doc.
- **tasks-core/server** owns both tables and exports `workspaceOfConversationLookup` (conversations ⋈ attempts, by `conversations.id`) and `workspaceOfAttemptLookup`. Callers outside `conversations/workspace` move to `lookup.run`; `workspace-of.ts`'s raw SQL is reduced to what workspace-internal callers still need, so one copy of the join remains.
- **Adopt in the same change:**
  - edited-files (`READS = { lookups: [workspaceOfConversationLookup.read], reason }` for pages, meta and `edited-files.file`; `worktreeFor` → `.run`);
  - allow-monitor (`allow-files-resource.ts`, same lookup);
  - commits-graph (`resources.ts:78`, if it is the same binding).

  code-explorer's `workspaceRootReads` is optional; it can follow as a task.
- **Subscribe-before-row race** (*as landed:* `packages/parked-watch`, shared by edited-files and allow-monitor; a parked open that fails is reported and re-parked, retried by the next resolving load) (exists today, and step 4 no longer hides it): `watchConversation` returns a no-op stop when the row is missing, so a later INSERT re-runs the loader once but no watch ever opens, leaving the value stale forever. Park the watch as code-explorer's `rootWaiters` does (`code-explorer/machine/internal/workspace.ts:25-92`): the first load that resolves the worktree opens it.

What each write then does:
- conversations UPDATE (every turn): gated out.
- conversations INSERT/DELETE: re-runs only that conversation's questions.
- attempts UPDATE: gated out.
- attempts INSERT/DELETE: every edited-files question re-runs once, at launch rate.

### 5. Slow-op element identity (debug/slow-ops)

Extract a pure `elementSlowOp(info, thresholds, route)` from `slow-op-collector.tsx:64-96`, beside `latencySlowOp`, using its rule: `operation = info.key` and `detail.variant = canonicalJson(info.params)` (`latency-slow-op.ts:18-37`). The result is one report row (one toast) per resource key, with per-conversation and per-page variants kept in `slow_ops.variants`. No descriptor `family` and no settle coalescing: folding `:meta` into its pages, if wanted later, must be designed for the element, update and loader producers together. Old per-params rows remain as history.

**Rejected:**
- `throttleMs`: notify already fires only on a real list change, and a debounce adds latency.
- A `whileSubscribed → { stop, context }` API: blind to the HTTP read path (`runtime.ts:7413-7460`) and to failed starts, so its fallback lookup would trip D5 and drift-route FULL.
- An immutable conversation→worktree cache: the binding is unenforced (`touchedBy` marks `worktreePath` mutable), and it removes only the cheap lookup.
- `core.untrackedCache`: `runGit` passes `--no-optional-locks`, so it never persists, and an index write would make the memo trigger itself.
- Warm-on-close: unsound (see §1).

## Order of work

1. Measure the baseline on main: `get_runtime_profile` loader spans for `edited-files` and `edited-files:meta` by parent (sub / push), notifyStats hand vs feed, `deliver:*`, `flushOpenMs`, the git-memo hit/miss markers.
2. §1 + §2 + §3, with tests. Build and measure.
3. §4, with tests. Build (this rebuilds the conversations/attempts triggers) and measure.
4. §5.

## Critical files

- New: `plugins/packages/plugins/watched-memo/core/{index.ts,internal/watched-memo.ts,internal/watched-memo.test.ts}`, `plugins/infra/plugins/query-resource/server/internal/compile-lookup.ts` (+ test).
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/{edited-files-signature,compute-edited-files,edited-files-cache,watch-edited-files}.ts`, `machine/internal/edited-files-resource.ts`, `core/resources.ts` (comment), `CLAUDE.md`.
- `plugins/primitives/plugins/commit-list/server/internal/parse-diff-z.ts` (`parseDiffRawNumstatZ`).
- `plugins/infra/plugins/file-watcher/shared/engine.ts`, the dir-hub, `plugins/infra/plugins/git/plugins/checkout-watch/server` (`onResync`).
- `plugins/infra/plugins/query-resource/server/internal/routes.ts`, `plugins/framework/plugins/resource-runtime/core/runtime.ts` + its `CLAUDE.md` (D31), `plugins/network/plugins/live/server/internal/serve-value.ts`.
- `plugins/tasks/plugins/tasks-core/server` (lookups), `plugins/conversations/plugins/workspace/server/internal/workspace-of.ts`, allow-monitor `allow-files-resource.ts`, commits-graph `resources.ts`.
- `plugins/debug/plugins/slow-ops/web/components/slow-op-collector.tsx`, new `web/internal/element-slow-op.ts` (+ test).

## Verification

- **Unit tests** (`./equin test <path>`):
  - **watched-memo** (fake `changes` / `facts`):
    - N gets during opening = 1 facts + 1 compute;
    - a trigger mid-pass → 1 trailing pass + 1 notify;
    - a write made and undone mid-pass is corrected;
    - an equal value → no notify, same object;
    - a failed pass demotes, and `get` throws through the probe path;
    - `first` settles on open failure, on pass-1 failure, and on release-while-opening;
    - a pass after close writes nothing;
    - resync triggers a pass.
  - **commit-list:** `parseDiffRawNumstatZ` with renames, copies, binaries, and paths with spaces, quotes and newlines.
  - **code:** a compute/signature path-set parity test on a C-quoted path (extend `edited-files-signature.test.ts`).
  - **query-resource `routes.test.ts`:** derived lookup columns and match, the refusals, and label-scoped drift coverage.
  - **resource-runtime external keyed tests:**
    - a gated U reaches no page;
    - a conversations I/D reaches only its question;
    - an attempts I reaches all;
    - change-feed `resolveLayout` gates conversations {id, attempt_id} and attempts {id, worktree_path, workspace}.
  - **live `serve-value.test.ts`:** the keyed branch uses a reach plan.
  - **slow-ops:** `element-slow-op.test.ts`.
- **e2e** `plugins/conversations/plugins/conversation-view/plugins/code/e2e/edited-files-cost.ts`, modelled on `jsonl-viewer/e2e/no-op-frames.ts`:
  - subscribe to the pages (limit 2000) + meta, and time sub → first frame cold/warm;
  - make N `viewed` writes on other conversations → 0 edited-files loader runs and 0 frames (`_debug` notifyStats.feed flat);
  - touch a worktree file → 1 `watch-edited-files:pass` and 1 frame per tuple;
  - an HTTP GET of the page tuple → no D5 drift (`routeDrifted` empty);
  - subscribe before the attempt row exists → resolves and watches after the insert.
- **Live acceptance**, after `./equin build`, on this worktree's build and then on main once pushed:
  - the runtime profile shows at most one `status -uall` per open and none per loader run while watched;
  - `push deliver:edited-files` is under budget;
  - `slow_ops` / reports (`query_db`) hold one `element edited-files` and one `element edited-files:meta` row;
  - opening the review pane on a ~500-file worktree raises no slow-op toast.

## As landed: the status read, and what a cold open still costs

- `git status -uall` matches every path of the checkout against the excludes (27.9k paths visited vs 10.3k for `-unormal` on this repo; `read_directory` 0.67 s vs 0.07 s). `readEditedFilesFacts` reads `-unormal -z` and expands each untracked dir it names with `ls-files -z --others --exclude-standard` — the same entries (embedded repos stay `dir/`; pinned by a parity test against `-uall`), 0.32 s vs 0.73 s.
- Measured with `e2e/edited-files-cost.ts` on this worktree (load avg 8–12): warm open 3–4 ms; per unrelated conversations write 0 loader runs / 0 frames / feed flat; per file change 1 pass and 1 frame per tuple; push re-runs 3–12 ms; a pass ~0.9 s; **cold open ~1.6 s** = the watch opening (conversation lookup + `acquireCheckoutWatch`, ~0.5 s, awaited before pass 1 so every later write is heard) + pass 1. A cold open of a large worktree can therefore still cross the 1 s element threshold; overlapping the watch open with pass 1 (and running one trailing pass once it is live) would bring it to ~one pass, at the price of a second pass per open — not done.
