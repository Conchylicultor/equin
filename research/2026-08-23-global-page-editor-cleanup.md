> **Status (2026-08-23).** Applied. The `membership` declaration and every claim
> about it are out of the branch, the leftover `TEMP-EXPERIMENT:` line is gone, and
> §4's pre-existing false claim in `shared/schemas.ts` was corrected (each VALUE is
> bounded by the params; the ROUTING is not). The comments now say plainly that the
> fan-out is still there and is an open problem with its own task.

# Cleanup: bring the page-editor branch to a clean, shippable state

Worktree `att-1787320384-u0hp`, branch `claude-web/att-1787320384-u0hp`. Nothing committed or pushed.

**Goal:** the branch should contain only verified work. One change on it (a `membership` declaration
on two live-state resources) caused a reproducible regression and must come out, along with every
comment and doc line that asserts it. Everything else stays.

Redesigning that resource scoping is **out of scope here** — it has its own task, to be designed from
scratch.

---

## Keep — verified, unaffected

**Attachment reconcile batching**
- `plugins/infra/plugins/attachments/server/internal/define-link.ts` — new `setMany`, and
  `applyLinkDiff` extracted as an executor-parametrized function so the real SQL runs against a
  throwaway Postgres. `set()` delegates to it, so there is one implementation.
- `plugins/infra/plugins/attachments/server/internal/define-link.test.ts` (untracked — `git add`)
- `plugins/infra/plugins/attachments/CLAUDE.md`
- `plugins/page/plugins/attachment-block/server/internal/reconcile.ts` and `reconcile-job.ts`

  The point is **silence, not batching**: an edit that changes no attachment links issues one indexed
  SELECT and zero writes, where before it ran one transaction per block. Do not "simplify" it into
  delete-all-then-reinsert — that rewrites unchanged rows and fires the change-feed for a no-op.

**Editor hydration**
- `plugins/page/plugins/editor/web/components/collab-text-plugin.tsx`
- `plugins/page/plugins/editor/web/components/hydration-placeholder.tsx`
- `plugins/page/plugins/editor/web/internal/collab-session.ts`
- `plugins/page/plugins/editor/web/internal/use-collab-block-doc.ts`
- `plugins/page/plugins/editor/web/__tests__/collab-hydration-state.test.ts`
- `plugins/page/plugins/editor/CLAUDE.md`

**Row-key fix on the TODO task link** — independent of the reverted work, keep it.
- `plugins/page/plugins/annotations/plugins/todo/plugins/task-link/shared/schemas.ts`
  (`keyOf` `taskId` → `blockId`). `mergeKeyedDelta` reconciles by `keyOf(row)` against the server's
  `order` list, which carries identity-table ids (`parent_id` = blockId); with `taskId` the lookup
  could never match and fell into the `drift`-and-resync arm.

**Runtime point-routing test** — keep.
- `plugins/framework/plugins/resource-runtime/core/runtime-window-membership.test.ts` — adds
  *"a write to one id never reaches another id's subscriber, even when the loader ignores ctx"*.
  It passes and is honest coverage of the runtime, independent of any consumer.

---

## Revert — the `membership` declaration and every claim about it

### 1. `plugins/page/plugins/editor-collab/server/internal/resource.ts`

- Remove the `// TEMP-EXPERIMENT:` line left behind by a causation test.
- The `membership: { kind: "point", … }` line is already gone here — keep it gone.
- The module comment was rewritten to explain the membership at length. Rewrite it again so it
  describes only what the code does. Do **not** restore the pre-existing text verbatim either: the
  original claimed *"only that block's subscribers recompute — subscribers of other blocks get an
  empty scoped refill … and no push"*, and the second half is what hid the cost. Subscribers of other
  blocks **do** recompute (each runs its own `where block_id = ?`); they merely receive no frame.
  State that plainly, and note the fan-out is a known open problem with its own task.
- Keep the `stateToBase64` / base64-encoding paragraph verbatim — it explains why the loader is
  hand-written rather than compiled, and is unrelated.

### 2. `plugins/page/plugins/annotations/plugins/todo/plugins/task-link/server/internal/resource.ts`

- Remove `membership: { kind: "point", idsOf: ({ blockId }) => [blockId] },`.
- Same comment treatment as above. The comment it replaced argued that a scoped refill would save no
  work *per call* — which is true and beside the point, since the cost is how many calls there are.
  Keep that correction; drop everything asserting a membership that no longer exists.

### 3. Docs asserting the membership

- `plugins/page/plugins/editor-collab/CLAUDE.md` — the `blockContentResource` bullet.
- `plugins/page/plugins/annotations/plugins/todo/plugins/task-link/CLAUDE.md` — the paragraphs added
  about point membership. Keep the `blockId` row-key explanation, which belongs to the kept fix.

### 4. Pre-existing false claim — fix or flag, your call

`…/task-link/shared/schemas.ts` already said, **before any of this work**:

> Keyed with `{ blockId }` params — POINT membership, so the working set is bounded by construction

That was untrue when written and stays untrue after the revert. Either correct it or leave it with a
note; do not leave it reading as though the bound exists.

### 5. Generated file

`plugins/framework/plugins/server-core/core/server.generated.ts` is codegen. Don't hand-edit;
`./equin build` regenerates it.

---

## Verify

```bash
./equin test plugins/infra/plugins/attachments \
                   plugins/page/plugins/editor \
                   plugins/page/plugins/editor-collab \
                   plugins/framework/plugins/resource-runtime
./equin build     # runs ./equin check — type-check included
```

Then the CRDT e2e, which is what caught the regression:

```bash
bun plugins/page/plugins/editor/e2e/crdt-split-merge-verify.ts        # must pass 17/17
bun plugins/page/plugins/editor-collab/e2e/crdt-multitab-agent-verify.ts
bun plugins/page/plugins/editor-collab/e2e/crdt-offline-verify.ts
bun plugins/page/plugins/editor/e2e/crdt-reopen-verify.ts
bun plugins/page/plugins/editor/e2e/crdt-typing-verify.ts
```

Two known results that are **not** caused by this branch — confirm they are unchanged rather than
chasing them:

- `crdt-adjacent-surfaces-verify.ts` fails its `[[page]]`-token and backlink checks **identically on
  `main`**. Pre-existing; deserves its own task.
- `crdt-offline-verify.ts` fails its 9th check, `second context converges — ""`, **identically on
  `main`** (8/9 both sides; the offline/reconnect checks it exists for all pass). Confirmed by
  baseline on 2026-08-23. Pre-existing; deserves its own task.
- `crdt-typing-verify.ts` is the same fixed-wait shape as `crdt-newblock` below: its context-B step
  waits a fixed 5 s (`crdt-typing-verify.ts:82`) before requiring the editable to be visible, and it
  times out when the machine is loaded — e.g. when the five scripts are run back-to-back. Re-run it
  alone before treating it as real; it passes 4/4 on both worktree and main that way.
- `crdt-newblock-verify.ts` can fail `CONVERGENCE` with `got []`. Its context-B step waits a fixed
  5 s (`crdt-newblock-verify.ts:136`) and that is not always enough on a loaded machine. Baseline it
  against main before treating it as real: every script takes `--base http://equin.localhost:9000`.

### Harness notes

- `./equin test` and `./equin build` must run with `run_in_background: true` (a guard
  enforces it).
- **The build's authority is the receipt**, `~/.singularity/worktrees/<wt>/build-status.json`
  (`status: ok`). A piped `./equin build … | tail` exits 0 even when the build failed.
- `bun test` does not type-check. Only the build (or `./equin check type-check`) runs both
  gates.

---

## Related docs

- [`2026-08-21-global-page-block-doc-fanout-and-attachment-reconcile.md`](./2026-08-21-global-page-block-doc-fanout-and-attachment-reconcile.md)
  — the original design. Its evidence for the attachment-reconcile flood stands and shipped. Its
  resource-scoping fix did not; see the status banner at its top.
