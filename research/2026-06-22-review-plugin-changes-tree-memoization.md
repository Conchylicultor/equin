# Memoize plugin-tree builds in review/plugin-changes

## Context

`GET /api/review/plugin-changes` and the `review.plugin-changes` live-state
resource both call `computePluginChanges`, which builds the **full plugin tree
twice** (`buildPluginTree` × 2 — once for the worktree, once for `main`).
`buildPluginTree` is a build-time primitive: a fully synchronous recursive
`readdirSync` walk over hundreds of plugin dirs, plus synchronous file reads +
facet extraction for ~10 facets per node (several of which walk *every* `.ts`
file in the repo to build reverse indexes). None of it yields to the event
loop, so each call blocks the backend for tens of seconds.

The recent commit `8e3a408fc` already moved the working-tree path off an HTTP
request onto the `review.plugin-changes` push resource (re-keyed onto
`editedFilesResource` + `refHeadResource`) and added a `withHeavyReadSlot` gate.
What remains is the **redundant rebuild** that the gate cannot fix:

- **File-save hot path** — every worktree file save fires `editedFilesResource`,
  which recomputes the resource and rebuilds the **main** tree, even though
  `main` only changes when a ref advances. This is the dominant event during
  active agent work.
- **refHead fan-out** — when `main` advances, `refHeadResource` fans out to
  *every* active review conversation; each recompute rebuilds its **worktree**
  tree, even though only `main` moved and the worktree filesystem is unchanged.

The gate alone only **serializes** this redundant work — it mutes the visible
event-loop-starvation signal (the 45s SELECTs / 164s flushes) while the
redundant rebuilds keep queuing. The fix is to stop rebuilding what hasn't
changed, using the existing `git-read-cache` primitive
(`createGitStateMemo`). The gate then becomes correct defense-in-depth: cache
**hits skip the gate entirely**; only genuine **misses** take a heavy-read slot.

Intended outcome: each distinct plugin tree is built **at most once per
sha / per generation**, and shared across all subscribers on the backend
(single-flight). Steady-state recomputes drop from 2 full tree builds to 0–1.

## Approach

Memoize **both** tree builds with `createGitStateMemo`
(`@plugins/infra/plugins/git-read-cache/server`), following the
`commits-graph` precedent (`compute-graph.ts`): the `signatureFn` is a cheap,
**ungated** read; the `computeFn` owns the `withHeavyReadSlot`.

### 1. Make `computePluginChanges` pure (takes prebuilt trees)

`plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts`

Change the signature so the function no longer builds trees or holds the gate —
it becomes pure diffing logic over two already-built `PluginTree`s:

```ts
export function computePluginChanges(
  worktreeTree: PluginTree,
  mainTree: PluginTree,
  editedFiles: EditedFile[],
): PluginChangeDiff[]
```

Drop the `buildPluginTree` import and the `Promise.all([...])` block; flatten the
two passed-in trees instead. Everything below `flattenTree(...)` is unchanged.
(No longer `async` — callers stop `await`ing it, or keep it `async` returning the
array; prefer dropping `async` since it's now pure.)

### 2. New memo module for the two cached trees

New file: `plugins/review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts`

Two module-level memos. Each `computeFn` owns the `withHeavyReadSlot` so a hit
never takes a slot:

```ts
import { buildPluginTree, type PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { createGitStateMemo } from "@plugins/infra/plugins/git-read-cache/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host-read-pool/server";
import { lastKnownMainSha } from "@plugins/infra/plugins/git-watcher/server";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { currentGeneration } from "@plugins/conversations/plugins/conversation-view/plugins/code/server";

// main tree: keyed by the (constant) mainPluginsDir → one cache entry, shared
// across all conversations on this backend; signature = main's HEAD sha.
const mainTreeMemo = createGitStateMemo<PluginTree>({ name: "review.plugin-changes.main-tree" });

export function getMainPluginTree(mainPluginsDir: string): Promise<PluginTree> {
  return mainTreeMemo.get(
    mainPluginsDir,
    async () =>
      lastKnownMainSha() ?? (await runGit(["rev-parse", "main"], mainPluginsDir))?.trim() ?? "",
    () => withHeavyReadSlot(() => buildPluginTree(mainPluginsDir, { skipBarrelImport: true })),
  );
}

// worktree tree: keyed by worktreePath; signature = edited-files generation
// counter (monotonic, bumps on every worktree recompute, never on a bare ref
// advance → faithful + never-stale; main advancing alone keeps it stable).
const worktreeTreeMemo = createGitStateMemo<PluginTree>({ name: "review.plugin-changes.worktree-tree" });

export function getWorktreePluginTree(worktreePath: string, worktreePluginsDir: string): Promise<PluginTree> {
  return worktreeTreeMemo.get(
    worktreePath,
    () => Promise.resolve(String(currentGeneration(worktreePath))),
    () => withHeavyReadSlot(() => buildPluginTree(worktreePluginsDir, { skipBarrelImport: true })),
  );
}
```

Notes:
- `runGit` here is the ungated micro-call from `@plugins/primitives/plugins/commit-list/server` (same one `probeHeadMain` uses). The `lastKnownMainSha()` fast path means the fallback rarely runs.
- Keying the main memo by `mainPluginsDir` (constant per backend) gives a single entry + backend-wide single-flight: when `main` advances and the refHead fan-out wakes N conversations, they all share **one** main-tree rebuild.

### 3. Export `currentGeneration` from the code plugin barrel

`plugins/conversations/plugins/conversation-view/plugins/code/server/index.ts`

Add the one new cross-plugin export (it already exists in
`internal/edited-files-cache.ts`, just not surfaced):

```ts
export { currentGeneration } from "./internal/edited-files-cache";
```

### 4. Wire the resource to the memos; drop the outer gate

`plugins/review/plugins/plugin-changes/server/internal/plugin-changes-resource.ts`

In `computeWorktreePluginChanges`, replace the `withHeavyReadSlot(() => computePluginChanges(dirs...))`
call with: fetch both memoized trees, then call the now-pure diff:

```ts
const worktreePluginsDir = join(conversation.worktreePath, "plugins");
const [worktreeTree, mainTree] = await Promise.all([
  getWorktreePluginTree(conversation.worktreePath, worktreePluginsDir),
  getMainPluginTree(mainPluginsDir),
]);
const plugins = computePluginChanges(worktreeTree, mainTree, editedFiles);
return { plugins };
```

Remove the now-unused `withHeavyReadSlot` import from this file — the gate now
lives inside each memo's `computeFn`, so **cache hits skip it** (the whole point;
the old outer wrap would have gated hits too). `getEditedFiles` is still fetched
in the same `Promise.all` as before.

### 5. Push path (`handle-plugin-changes.ts`) — keep gated, adapt to pure diff

`handlePush` diffs two **immutable historical** shas (base/head) extracted to
temp dirs. Do **not** memoize per-sha (unbounded cache growth; this path is rare,
already `dedupe: true` + `concurrency: 2`). Just adapt to the new pure
`computePluginChanges`: inside the existing `withHeavyReadSlot`, build both trees
from the extracted dirs and pass them in:

```ts
return withHeavyReadSlot(async () => {
  const [baseDir, headDir] = await Promise.all([
    extractPluginsAtSha(baseSha),
    extractPluginsAtSha(headSha),
  ]);
  try {
    const [headTree, baseTree] = await Promise.all([
      buildPluginTree(join(headDir, "plugins"), { skipBarrelImport: true }),
      buildPluginTree(join(baseDir, "plugins"), { skipBarrelImport: true }),
    ]);
    return { plugins: computePluginChanges(headTree, baseTree, editedFiles) };
  } finally {
    await Promise.all([
      rm(baseDir, { recursive: true, force: true }),
      rm(headDir, { recursive: true, force: true }),
    ]);
  }
});
```

Add the `buildPluginTree` import here.

### Self-reporting threshold — leave untouched

The resource loader is timed via `recordEntrySpan("loader", "review.plugin-changes", …)`
against the global `slowOpConfig.loaderMs` (2000ms); the endpoint via
`httpMs` (2000ms). There is no per-endpoint config to remove. The span wraps the
whole loader, so a genuine miss that queues on the heavy-read gate still reports
itself. **No change** — the endpoint keeps reporting itself when slow.

## Cache-behavior summary (after the change)

| Trigger | main memo | worktree memo | Tree builds |
|---|---|---|---|
| Worktree file save (`editedFilesResource`) | hit (sha stable) | miss (gen bumped → rebuild) | 1 |
| `main` advances (`refHeadResource` fan-out) | miss once, shared by all convos | hit (gen stable) | 1 (shared) |
| Own-branch commit (`refHeadResource`) | hit | miss if gen bumped, else hit | 0–1 |
| Repeated mount / focus | (resource already cached by `8e3a408fc`) | — | 0 |

## Non-goal / follow-up (deferred)

The deeper question — *should a whole-tree facet build run on a request path at
all?* — is deferred. A partial/lazy build (extract facets only for the touched
plugins) would cut even the single remaining build to O(touched), but several
facets' `relate()` steps build **whole-tree reverse indexes** (`importedBy`,
`contributors`, `endpointCallers`, `consumers`); doing it safely needs an audit
of which facet fields the client `PluginChanges.DiffRenderer` slot actually
diffs. Memoization already meets the perf goal (each tree built ≤ once per
sha/generation, shared across subscribers) with **zero correctness risk**, so the
partial-build redesign is recorded as a follow-up rather than bundled here.

## Files to modify

- `plugins/review/plugins/plugin-changes/server/internal/compute-plugin-diff.ts` — make pure (take prebuilt trees).
- `plugins/review/plugins/plugin-changes/server/internal/plugin-tree-cache.ts` — **new**: the two memos.
- `plugins/review/plugins/plugin-changes/server/internal/plugin-changes-resource.ts` — use memos; drop outer gate.
- `plugins/review/plugins/plugin-changes/server/internal/handle-plugin-changes.ts` — build trees inline (still gated), pass to pure diff.
- `plugins/conversations/plugins/conversation-view/plugins/code/server/index.ts` — export `currentGeneration`.

## Verification

1. **Build:** `./equin build` (regenerates nothing schema-wise; confirms TS + barrel-purity + boundary checks pass — the new git-watcher / git-read-cache / commit-list / code imports are all legal runtime-barrel imports).
2. **Checks:** `./equin check type-check plugin-boundaries` — confirm the new cross-plugin export and imports don't trip boundary rules, and the pure `computePluginChanges` signature change type-checks at both call sites.
3. **Functional (push path):** open a review pane for a push (`/api/review/plugin-changes?pushId=…`) and confirm the per-plugin API/file diffs render identically to before (pure refactor of the diff logic).
4. **Functional (worktree path):** open a review pane on an active conversation; edit a worktree plugin file → confirm the changed plugin's diff updates. Confirm an *unrelated* main advance does **not** change the worktree diff content.
5. **Memoization proof:** the `git-memo-hit:review.plugin-changes.main-tree` / `…worktree-tree` and `git-memo-miss:…` markers are emitted automatically by `createGitStateMemo`. Inspect the runtime-profiler / Debug → Reports:
   - Repeated file saves → main-tree shows **hits**, worktree-tree **misses**.
   - A `main` advance with several active review panes → main-tree shows **one miss** (single-flight), worktree-tree shows **hits**.
6. **Starvation signal gone:** under a burst (edit files while several review panes are open) confirm the previously-observed multi-second loader spans / event-loop lag drop, while the `review.plugin-changes` loader still appears in the slow-op reports if a genuine cold miss exceeds 2000ms (self-reporting preserved).
