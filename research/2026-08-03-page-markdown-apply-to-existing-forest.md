# Applying edited markdown onto an existing page without destroying block identity

## Context

`core/markdown.ts` landed markdown ⇄ block-forest as a lossless projection
([`2026-08-03-page-markdown-block-roundtrip.md`](./2026-08-03-page-markdown-block-roundtrip.md)),
but there is no path to **apply** an edited markdown document back onto an existing page.

The only whole-page write is `replacePageContent` (`server/internal/page-content.ts`), which
re-mints every block id. That is *correct* for its one caller — version-history restore, where
fresh ids are load-bearing (the wipe FK-cascades every `page_block_docs` row, and restored rows
re-seed their content docs from `data.text`). As an *editing* path it is destructive: re-minting
ids drops each block's content `Y.Doc`, its `Y.UndoManager` history, the `page_links` backlink
edges, the `tasks_ext_prompt_block` link, and every entity-extension side-table keyed on block id
(`page_blocks_ext_starred`, `page_blocks_ext_origin`, `page_blocks_ext_story`).

The goal is agents editing pages the way they edit files: read markdown, write back a
mostly-identical document with a localized change. That needs a **structural diff/merge** —
match the incoming forest against the existing one, emit a minimal `BlockPatch`, and route text
changes into surviving blocks' content docs rather than their rows.

**We are not accepting the remint.** An agent editing one word must not detach every prompt block
on the page from its task, unstar every starred block, and reset the undo history.

### What the exploration established (verified, load-bearing)

Four facts make this tractable, and each one removes a blocker the task statement assumed:

1. **Server-side Yjs text writes are already possible.** `editYDocState(state, edit, opts)`
   (`primitives/collab-doc/core/internal/headless-collab.ts`) replays existing doc state into a
   headless replica wired both ways, runs a Lexical edit, and returns the **incremental** update —
   explicitly documented for "content-doc surgery on blocks with no mounted editor". Paired with
   `runsToXmlText`/`xmlTextToRuns` (`editor/core/runs-yjs.ts` — **core**, not web) and
   `doc-store.ts`'s `loadBlockDoc`/`initBlockDoc`/`mergeBlockDocUpdate`, the server can write a
   block's text without touching its row.
2. **`RowData`'s `{ text?: never }` is a client-side row-write guard**, not a wire constraint.
   `BlockFieldChanges.data` is `unknown`. So the constraint to honour is the *invariant* (the doc
   owns text), not a type that blocks the work.
3. **Block handles are server-reachable.** Every block plugin contributes its full `BlockHandle`
   — `text` lens, `markdown` declaration and all — to `Editor.BlockData`
   (`server/internal/block-registry.ts`). So `MarkdownContext.handles` is available server-side
   with **zero new infrastructure**; markdown serialize/parse runs on the server today.
4. **`protectedSpans` is the one genuine gap.** It comes from `blockTextProtectedSpans()`, backed
   by the **web-only** imperative `registerBlockTextExtension` registry
   (`inline-page-link`, `inline-date`, `math/inline`, `url-paste`). Without it, server-side
   serialization corrupts `[[pageId]]` and `\(latex\)` tokens — the exact failure the
   required-not-optional `protectedSpans` parameter exists to prevent. Fixed in Step 1.

### Decisions taken (flag if you disagree — each is reversible)

- **Sub-pages are never deleted by a markdown apply.** A `<page id="…"/>` shell owns an entire
  other `page_id` partition; deleting it destroys a whole page tree. A shell absent from the
  incoming markdown is **preserved in place**, exactly as `deletePageContentRows` already does for
  history restore. Removing a sub-page stays an explicit act, never an inferred one.
- **Text is spliced, not replaced.** For a surviving block we replace only the changed middle span
  (common prefix/suffix trimmed), so untouched characters keep their CRDT identity.
- **Scope is engine + write path + agent-facing MCP tools** — the motivating goal end to end.
  There are no page MCP tools today.

---

## Design

### The shape

```
markdown ──parse──> SerializedBlock[]  ┐
                                       ├─ planMarkdownApply ──> { patch: BlockPatch,
existing rows ─────> StoredBlock[]     ┘                         textEdits: TextEdit[] }
                                                                          │
                                            ┌─────────────────────────────┴────────────┐
                                    structure (locked tx)                text (post-commit)
                                    applyPageBlockPatch                  doc splice → row projection
```

Two channels, because they have two owners: structure is `page_blocks` rows under the page lock,
text is the per-block `Y.Doc`. Text for **newly created** blocks rides in `creates[].data.text` —
legal and required: a brand-new id has no doc, so its row *is* the seed.

### New plugin: `plugins/page/plugins/markdown-apply/`

It cannot live in `page/editor`. Verified cycle constraint: `page/editor/web` imports
`page/editor-collab/core`, and `page/editor-collab/server` imports `page/editor/server` — so
`page/editor` may not import editor-collab's server barrel. A new sub-plugin depending on both is
the resolution.

- `core/` — pure matching engine. No DB, no React, `bun:test`-able.
- `server/` — the applier + the MCP tools.

It also may not write `_blocks` itself (`page-editor/no-adhoc-forest-write`), which is what forces
the seam in Step 2 — and that is the rule working as intended: exactly one forest-write path
survives.

### Step 1 — Make `protectedSpans` server-reachable

Each inline-token plugin's regex moves into its own `core/` (it is pure data), and is referenced
by **both** registries:

- web: the existing `registerBlockTextExtension({ pattern, parseNode, serializeNode })` — the
  Lexical halves stay web-only;
- server: a new `Editor.InlineToken` contribution in `server/internal/block-registry.ts`, sibling
  to `Editor.BlockData`, carrying `{ pattern }` only.

Touches `page/{inline-page-link,inline-date,math/inline,url-paste}`. Add
`blockTextProtectedSpans()`'s server twin next to `resolveBlockHandle`. Because both registries
read the *same* core constant, they cannot drift — no parity check needed.

### Step 2 — Extract the sanctioned patch seam

`handle-patch-blocks.ts` currently mixes HTTP with a complete, correct patch applier (trash
symmetry, page-type transition guard, `parkRanks`, `notifyStructuralChange`). Extract its body to:

```ts
// page/editor/server — new export
export async function applyPageBlockPatch(
  pageId: string,
  patch: BlockPatch,
): Promise<{ blocks: Block[]; watermark: string }>;
```

`handlePatchBlocks` becomes a thin `implement()` wrapper over it. Pure refactor, no behaviour
change, and it keeps the "one forest-write path" invariant intact rather than adding a second.

Also export from `page/editor-collab/server`: `loadBlockDoc`, `initBlockDoc`,
`mergeBlockDocUpdate`. These are bytes-in/bytes-out and stay faithful to that plugin's
content-agnostic charter — a runs-aware export would not.

### Step 3 — The matching engine (`markdown-apply/core/plan.ts`)

```ts
export function planMarkdownApply(args: {
  pageId: string;
  existing: StoredBlock[];
  incoming: SerializedBlock[];
  handles: BlockHandle<unknown>[];
}): MarkdownApplyResult;

export type MarkdownApplyResult =
  | { ok: true; plan: MarkdownApplyPlan }
  | { ok: false; reason: "unknown-page-ref" | "subpage-reparented"; detail: string };

export interface MarkdownApplyPlan {
  patch: BlockPatch;
  textEdits: { blockId: string; runs: RichText }[];
  stats: { survived: number; created: number; deleted: number; moved: number };
}
```

Discriminated result, per the repo's absorbable-failure rule — an empty patch means "nothing to
do", never "something went wrong".

**Identity key.** Flatten both forests to document order (rank-ordered DFS; `rowsToForest` is the
existing precedent for the row side). Per node:

- text-bearing (`handle.text` present) → `type \0 plainOf(runs)`
- void → `type \0 stableJson(data)`
- sub-page shell → pinned by row id (see below)

**Alignment — LCS first, similarity second.** Run `diffArrays` (the `diff` package, already a root
dep) over the two key arrays. The LCS gives order-preserving exact-match anchors, which is
precisely what a content-bucket matcher cannot do: a page with five identical `- item` lines pairs
them correctly by position, where `build-diff.ts`'s greedy bucket (the history-diff precedent)
would mis-pair. Then, within each gap between anchors, pair leftovers by best similarity requiring
same-type-or-same-text (normalized edit distance over the plain text, thresholded); same type +
changed text is an edit, same text + changed type is a conversion. Unpaired old → delete, unpaired
new → create. Complexity is O(N·D) on the flattened document, D being the edit size — near-linear
for the agent-edit case this exists to serve.

**Minimality.** The plan emits nothing for a node whose everything matches.

- `parentId` — only when the matched parent changed. Top-level maps to `pageId` (content blocks
  are physically parented to the page row).
- `rank` — per parent, take the survivors' desired order and keep the **longest increasing
  subsequence** by existing rank fixed; re-rank only the remainder, via `Rank.nBetween` between the
  fixed neighbours. Unmoved siblings keep their stored rank byte-for-byte. Reuse
  `rankWindow`/`positionalRank` from `core/block-forest.ts`.
- `type` / `data` — only when changed (`dataEqual` for `data`).
- **never `text`** for a survivor (that is the text channel), and **never `expanded`** — a parsed
  forest is uniformly `expanded: true`, so writing it would blow away every collapse state on the
  page. New blocks get `expanded: true`. State both as invariants in the module header.

**Sub-pages.** `serializeForestToMarkdown` stamps the row id into `<page id="…"/>`; on parse
`page-link` claims the tag (the sub-page handle is `serializeOnly`). So:

- an incoming `page-link` whose id matches a live sub-page shell child of this page → that shell is
  the survivor; it may be repositioned;
- an id naming a row that is **not** a live child of this page → `{ ok: false, reason:
  "unknown-page-ref" }`, loudly, rather than minting or misplacing;
- a shell **absent** from the incoming markdown → preserved, appended after the applied content
  (the `replacePageContent` rank-floor idiom). Never in `deleteIds`.

**Known bound, stated not hidden:** matching compares against `data.text`, which trails the doc by
≤1s. A concurrent in-flight keystroke can therefore make a match *suboptimal* (a block reads as
edited-and-rewritten rather than untouched). It cannot corrupt: the applier re-reads true runs from
the doc before splicing (Step 4).

### Step 4 — The applier (`markdown-apply/server/internal/apply.ts`)

```ts
export async function applyMarkdownToPage(pageId: string, markdown: string): Promise<ApplyReport>;
```

1. Read rows (`serializePageContent`), parse markdown with server-side handles +
   `protectedSpans`, `planMarkdownApply`. A refusal returns before any write.
2. **Structure**, atomically: `applyPageBlockPatch(pageId, plan.patch)` — one locked transaction,
   `notifyStructuralChange` fires from inside it as today.
3. **Text**, after commit (rows must exist for the FK; deleted blocks' docs have already
   FK-cascaded). Per edit, doc **before** row — a row write is downstream of the doc:
   - `state = await loadBlockDoc(blockId)`.
   - No doc row → build full state via `runsToXmlText(newRuns, { clientID: contentHash })` and
     `initBlockDoc`. It is first-writer-wins and **returns the authoritative state**, which closes
     the mount-race by construction: if we lost, we continue with the returned state.
   - Have state → `oldRuns = xmlTextToRuns(...)` (the doc, not the lagging row), trim common
     prefix/suffix, `delta = editYDocState(state, replace-middle-with-new-runs)`,
     `mergeBlockDocUpdate(delta)`.
   - Then the row projection: one `applyPageBlockPatch` update naming `data` only, with
     `text: newRuns`.
4. Return `ApplyReport` (`stats` + the surviving/created ids).

**The projection is not optional.** `useTextProjection` is client-side and needs a *mounted
editor*; if the server writes a doc for a page nobody has open, `data.text` never updates and
search, backlinks, history and `read-only-view` all read stale text forever. The applier knows the
exact new runs, so it writes the projection itself — the same value a mounted client would have
written, which is why a later client flush is a harmless empty diff, not a fight.

**Partial failure.** Step 2 is atomic. Step 3 is per-block and throws loudly naming the `blockId`,
leaving structure applied and some text written. That is recoverable rather than corrupt because
**the plan is a pure function of current state**: re-running the same apply converges (already-
applied blocks match and emit nothing). Document idempotence-as-recovery in the module header;
do not add a silent retry.

### Step 5 — MCP tools (`markdown-apply/server/internal/mcp-tools.ts`)

Mirror `plugins/tasks/server/internal/mcp-tools.ts`.

- `read_page({ pageId })` → markdown, via `serializeForestToMarkdown` with server handles.
- `write_page({ pageId, markdown })` → `applyMarkdownToPage`, returning the stats so an agent sees
  what its write did.
- `edit_page({ pageId, oldString, newString, replaceAll? })` → read, string-replace (unique-match
  or loud error, matching the Edit tool's contract), apply. This is the ergonomic path and the one
  that makes the whole design pay off: a localized string edit produces a near-perfect LCS
  alignment, so exactly one block changes.

**Provenance.** `agentOriginCreateHook` reads `x-singularity-origin` off an HTTP `Request`; an MCP
tool has no such request. It also only marks whole *pages* an agent created, which a markdown apply
never does — it edits an existing page. So agent-origin does **not** apply here and needs no
plumbing. Note it explicitly so nobody later "fixes" it by faking a header.

### Concurrency — the honest bound

Deployment is one instance per user
([ADR](./2026-07-02-global-adr-single-instance-per-user.md)), so this is a real but narrow case: a
user typing in the same block an agent is rewriting. There is no lock on text. Yjs merges both:
untouched regions survive (which is what the prefix/suffix splice buys), overlapping regions
interleave. Structure is fully serialized by the page lock. This is a stated bound, not a defect to
engineer away.

---

## Files

**New** — `plugins/page/plugins/markdown-apply/{core,server}/index.ts` plus
`core/plan.ts`, `core/align.ts`, `core/keys.ts`, `server/internal/{apply.ts,mcp-tools.ts}`,
`core/plan.test.ts`, `e2e/markdown-apply-verify.ts`.

**Modified**
- `plugins/page/plugins/editor/server/internal/handle-patch-blocks.ts` — extract
  `applyPageBlockPatch`; barrel export it.
- `plugins/page/plugins/editor/server/internal/block-registry.ts` — add `Editor.InlineToken` +
  the server `protectedSpans` accessor.
- `plugins/page/plugins/editor-collab/server/index.ts` — export `loadBlockDoc`, `initBlockDoc`,
  `mergeBlockDocUpdate`.
- `plugins/page/{inline-page-link,inline-date,math/inline,url-paste}` — token regex to `core/`,
  add the server contribution.

## Verification

**Unit** (`bun test plugins/page/plugins/markdown-apply/core/plan.test.ts`) — the load-bearing
property first:

- **Identity ⇒ no writes.** `planMarkdownApply(rows, parse(serialize(rows)))` yields an empty
  patch and zero text edits. Seeded-fuzz it over generated forests, mirroring
  `markdown.test.ts`'s 400-seed round-trip.
- Seeded fuzz over **edit scripts**: apply one random mutation (insert / delete / move / retype /
  retext) to the markdown, assert exactly the expected id set survives and the patch names exactly
  the expected fields.
- Repeated-identical-lines alignment (five `- item`s, edit the third) — the case that motivates LCS
  over content buckets.
- Sub-page: preserved when omitted; repositioned when moved; `unknown-page-ref` refusal.
- `expanded` is never named for a survivor.

**E2E** (`bun plugins/page/plugins/markdown-apply/e2e/markdown-apply-verify.ts`) — proves the
claim the whole design exists for. Star a block and launch a prompt block, open the page in a tab,
apply a one-word markdown edit via the tool, then assert: surviving block ids unchanged; the edited
block's text updated in **both** the doc and `data.text`; the star and the task↔block link intact;
the open editor converged without clobbering.

**Manual**: `./equin build`, then drive `read_page` → `edit_page` over a real page via MCP
and confirm with `query_db` that ids and side-table rows survived.
