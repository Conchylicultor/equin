# Agent access to pages: block-scoped markdown, redacted, notes-only

## Context

`page/markdown-apply` (738379f3c, 2026-08-03) shipped `read_page` / `write_page` /
`edit_page`: an agent reads a page as markdown, edits the string, writes it back, and
block ids survive the round trip — so content docs, undo history, backlinks, stars and
task links survive with them. The projection is lossless and the applier is a structural
diff, not a re-mint.

What it does **not** have is a permission model. It is page-scoped and unrestricted: an
agent hands it a page id and can rewrite every word on that page, including a
`/private-notes` card the human wrote precisely so that no agent would see it. That is
the gap this plan closes, and it is the delivery step
[`annotations/CLAUDE.md`](../plugins/page/plugins/annotations/CLAUDE.md) predicted —
today `/private` "does not yet hide anything… a promise about a channel that does not
exist".

Four requirements, from the user:

1. Read/write/update in markdown, with the file `Read`/`Write`/`Edit` contract.
2. The input is a **block id**; only that block's **sub-blocks** are reachable.
3. `/private-notes` content is **never** exposed to an agent.
4. An agent may add and update **`/agent-notes` cards only** — never human content.
5. The conversation ids that wrote a card are recorded as **metadata on that card**, so
   a human can open the conversation that produced a note.

Requirement 1 is done. This plan is the other four.

## What already exists — do not rebuild it

| Thing | Where |
|---|---|
| Lossless markdown ⇄ forest | `page/editor/core/markdown.ts` — `serializeForestToMarkdown`, `parseMarkdownToForest` |
| Server-side protected spans | `page/editor/server` — `Editor.InlineToken`, `blockTextProtectedSpans()` |
| Structural diff + minimal patch | `markdown-apply/core/plan.ts` — `planMarkdownApply` |
| The one traversal both halves share | `markdown-apply/core/flatten.ts` — `documentOrderRows`, `markdownNodesOfRows` |
| Two-channel write (structure, then docs) | `markdown-apply/server/internal/apply.ts` |
| The sanctioned forest write | `page/editor/server` — `applyPageBlockPatch` |
| Block-keyed side tables | `infra/entity-extensions` — `defineExtension`; precedents `page_blocks_ext_origin`, `page_blocks_ext_starred` |
| Container anchor popover | `page/container/web` — `ContainerAnchor` with `sections` |

## The shape of the solution

**Requirements 2 and 4 are the same mechanism.** Writes are restricted not by validating
the patch a write produced, but by restricting what the agent can *address*: a write tool
accepts only a block id whose type is `agent-notes`, and the engine is scoped to that
block's subtree. The agent cannot touch human prose because it cannot name it.

**Requirement 4 then makes the hard half of requirement 3 free.** The obvious trap in
redaction is asymmetry: strip a private card on read, and a write that diffs the edited
document against the *full* stored forest reads every stripped card as a deletion.
Pinning them back positionally is real work — a private card between two paragraphs needs
a rank re-derived from its surviving neighbours after planning. But a private card cannot
legitimately live inside an agent-notes card, so the write scope never contains redacted
content. **Redaction only has to work on read.** The one residual case — a user drags a
private card into an agent-notes card — is a loud refusal, never a silent destruction.

## Delta 1 — root-scope the engine

Both walks already take the root as a parameter and use it only as the seed of
`byParent.get(root)`, and `deleteIds` derives from `oldRows` (the walk output), so
**delete authority is bounded by the root the moment the root is scoped**. This delta is
therefore mostly a rename plus one new refusal.

- `markdown-apply/core/flatten.ts` — rename the `pageId` parameter of
  `documentOrderRows` / `markdownNodesOfRows` to `rootId`. Behaviour unchanged.
- `markdown-apply/core/plan.ts` — rename `MarkdownApplyArgs.pageId` to `rootId`. Its six
  uses (walk seed, error text, the parent of top-level incoming nodes, the group key, the
  rank floor, the shell re-home target) are all root-of-scope semantics already.
  `existing` keeps taking every live row of the page partition; the walk reaches only the
  subtree.
- **New refusal, `subpage-removed`.** The absent-shell branch re-homes a shell that the
  document dropped to `rootId` above the rank floor. Correct when `rootId` is the page;
  wrong when it is an agent-notes card, where it would drag a sub-page into the card. When
  `rootId !== pageId`, an absent shell is a refusal instead. In practice unreachable —
  read emits every shell in scope — which is exactly why it should be loud.
- `markdown-apply/server/internal/read.ts` — `readBlockAsMarkdown(blockId, opts)`:
  resolve the owning page, `serializePageContent(pageId)`, then walk from `blockId`.
  The membership assert is **skipped when `blockId === pageId`**: a page's own row is not
  in its content partition, so "404 if `blockId` is not among the returned rows" — as this
  plan first said — would 404 every whole-page read. For a content block the assert is
  real and must stay, because a root that is not in the forest walks to an EMPTY document,
  which reads as "this block has no content" and would be written back as a full delete.
  A trashed block is likewise not addressable, for the same reason. Takes an optional
  `redact?: (rows: StoredBlock[]) => StoredBlock[]`, applied before the walk so pruning a
  card prunes its descendants. The engine never learns what an audience is.
- `markdown-apply/server/internal/apply.ts` — `applyMarkdownToBlock(blockId, markdown)`.
  The two-channel write, the page lock and the idempotence story are all unchanged;
  `applyPageBlockPatch` locks the whole forest either way.
- `readPageAsMarkdown` / `applyMarkdownToPage` are **not** thin delegations to the block
  entry points, contrary to this plan's first wording. Delegating would let a caller that
  means "this page" pass a CONTENT BLOCK id and silently read or rewrite the page around
  it. Each asserts page-ness instead — `serializePageContent` returning a snapshot IS the
  proof the id names a live page row — and then shares the scoped body. Both stay
  byte-identical to today for a page id.
- `loadBlockScope(blockId) → { pageId, rows }` is exported from the server barrel: a
  policy consumer has to decide *about* a block before naming it as a root (Delta 3's
  ancestor-chain audience walk, and the last-child rank for append), and re-deriving the
  block→page rule per consumer is what would drift.

## Delta 2 — audience, declared once

`audience` becomes an optional field on `BlockHandle` (`page/editor/core/define-block.ts`),
documented as *declared only by annotation containers; absent means ordinary page content,
visible to everyone*. It rides the handle, which is already what
`Editor.BlockData.getContributions()` hands the server — so there is no second registry to
drift from the first, and enumeration stays generic (filter for
`audience === "human"`, never name a type).

The fail-safe direction is preserved where it matters by making it unrepresentable rather
than defaulted:

- **New `plugins/page/plugins/annotations/core/define-annotation-block.ts`** —
  `defineAnnotationBlock` wraps `defineContainerBlock` and **requires** `audience`. A new
  annotation cannot be unmarked; there is no default to leak through.
- The four existing annotations move onto it: `context`, `todo`, `agent-notes` →
  `audience: "agent"`; `private-notes` → `audience: "human"`.
- **New check `annotations:audience-declared`** — every block type defined under
  `plugins/page/plugins/annotations/` must go through `defineAnnotationBlock`. This is what
  stops a future annotation from quietly being an ordinary container and defaulting into
  visibility.

Ordinary blocks being visible is correct, not a leak: the withheld-by-default rule from
`annotations/CLAUDE.md` is about the annotation family, and inside that family the field
is required.

## Delta 3 — the policy plugin

The four agent-facing tools move **out** of `markdown-apply` into a new plugin. Two
reasons: `append_agent_notes` names a concrete block type, which the generic engine must
not; and the redaction predicate is policy, not projection. `markdown-apply` keeps
exporting `readBlockAsMarkdown` / `applyMarkdownToBlock` and stays audience-agnostic.

**New `plugins/page/plugins/annotations/plugins/agent-access/`** — under `annotations`
because it is the filter-over-the-family that `annotations/CLAUDE.md` specified.

```
read_page(block_id)                       → subtree markdown, human-audience subtrees pruned
append_agent_notes(block_id, markdown)    → mints a new <agent-notes> card, returns its id
write_agent_notes(note_id, markdown)      → merge-apply within that card
edit_agent_notes(note_id, old, new)       → same, localized
```

- `read_page` keeps its name (it reads a page, or any block within one) and its `pageId`
  parameter becomes `blockId`. **Refuses** a `blockId` whose ancestor chain crosses a
  human-audience block — otherwise the id itself is the bypass.
- `write_agent_notes` / `edit_agent_notes` assert `type === "agent-notes"`, and refuse
  when the target subtree contains a human-audience annotation. `edit_agent_notes` keeps
  the existing `edit_page` contract verbatim (zero matches and non-unique-without-
  `replaceAll` are both loud) — that code moves, it does not get rewritten.
- `append_agent_notes` does **not** go through the planner. It builds the patch directly:
  one create for the card plus creates for its parsed children, ranked after `block_id`'s
  last child, through `applyPageBlockPatch`. Creates-only is structurally incapable of
  touching anything else, which a diff-based append would need a guard to promise. Text
  for created blocks rides `creates[].data.text` — legal and required, per the engine's own
  rule: a brand-new id has no doc, so the row is the seed and the client seeds the doc on
  first mount. Refuses when `block_id` is itself an agent-notes card (no nesting) or sits
  under a human-audience one.

`write_page` / `edit_page` are **removed**. This narrows a capability that shipped two
days ago — whole-page markdown editing is no longer reachable by any agent — which is the
explicit requirement, recorded here so the loss is deliberate rather than discovered later.
The engine that made it possible is untouched and the tools could be restored behind a
per-page human-set opt-in if that is ever wanted.

## Delta 4 — conversation provenance

**New `plugins/page/plugins/annotations/plugins/agent-notes/plugins/authorship/`**
(making `agent-notes` an umbrella, per the repo's grouping convention). It owns the record,
not the MCP plugin, so a future non-MCP writer reuses it.

- **Server** — a plain child table `page_blocks_agent_authors(block_id, conversation_id,
  created_at)` with the pair as the PRIMARY KEY, FK `block_id → page_blocks ON DELETE
  CASCADE`, growth bound asserted at boot by `markCascadeBounded`.

  This plan originally specified a 1:1 `defineExtension` holding a `conversationIds` array.
  **That was wrong and was rejected during implementation.** An array append is a
  read-modify-write: two conversations appending to one card in the same window both read
  the pre-write array, and the second silently drops the first's id — which is exactly the
  failure this record exists to prevent. The child table makes the append
  `INSERT … ON CONFLICT DO NOTHING`, so dedupe is the primary key rather than a check the
  writer must remember. Secondarily, the relation is genuinely 1:N and entity-extensions is
  a 1:1 primitive — its synthesized `parentId` PK is what makes it 1:1. A set is not a field.

  `conversation_id` carries **no** FK, deliberately, and for the same reason
  `page/prompt/link` omits one on its `blockId`: the row asserts something about the CARD
  ("an agent wrote this"), which stays true after the conversation row is gone. A CASCADE
  would erase the provenance and leave the card indistinguishable from human prose.

  `recordAgentNotesAuthor(blockId, conversationId)` is idempotent. **Call it only after the
  card's row is committed** — the `block_id` FK is the precondition, so a pre-commit stamp
  raises a foreign-key violation. (Unstated in this plan's first draft; found in
  implementation.)
- A keyed live resource `agent-notes-authors` with `{ blockId }` params — point membership,
  bounded by construction, so only a mounted card subscribes. Known trade: the change-feed
  can only attribute affected ids for a single-column PK, so a composite-PK table yields
  FULL-for-table and a stamp reloads every mounted card rather than only the written one.
  Accepted over adding a meaningless surrogate id column plus a separate unique index.
- **Web** — the card's anchor gains a popover. `ContainerAnchor` already supports
  `sections`; `agent-notes` currently passes none because its payload is `{}` and there was
  nothing per-instance to show. Provenance is per-instance, so the section lists the
  contributing conversations, each a chip opening `conversationPane`. No cycle:
  `plugins/conversations/` imports nothing from `@plugins/page/`.
- **One editor-core change**: `BlockAnchorProps` gains `blockId?: string`, passed at
  `block-row.tsx:135` (which has `block.id`). Optional, matching the existing `editor?`
  degradation — `read-only-blocks.tsx:380` documents that a read-only node legitimately has
  no id, so it renders the static glyph as it does today.
- The **MCP tool layer** stamps, not the apply engine: the tool is where `conversationId`
  lives, and the engine stays free of it.

## Implementation order

1. Delta 1 (rename + `subpage-removed` + the two server entry points). Self-contained;
   existing tools keep working against a page id throughout.
2. Delta 2 (`audience`, `defineAnnotationBlock`, the four migrations, the check).
3. Delta 3 (the `agent-access` plugin; remove `write_page` / `edit_page`).
4. Delta 4 (authorship side-table, resource, `blockId` prop, anchor popover).

## Files

**Modified** — `markdown-apply/core/{flatten,plan}.ts`,
`markdown-apply/server/internal/{read,apply,mcp-tools}.ts`,
`markdown-apply/{CLAUDE.md,e2e/markdown-apply-verify.ts}`,
`page/editor/core/define-block.ts`, `page/editor/web/types.ts`,
`page/editor/web/components/block-row.tsx`,
`annotations/plugins/{context,todo,agent-notes,private-notes}/core/*-block.ts`,
`annotations/plugins/agent-notes/web/components/agent-notes-anchor.tsx`,
`annotations/CLAUDE.md` (the "deliberate half" section stops being true).

**Created** — `annotations/core/define-annotation-block.ts`, `annotations/check/index.ts`,
`annotations/plugins/agent-access/**`,
`annotations/plugins/agent-notes/plugins/authorship/**`.

## Stated bounds

- **`read_page` reveals that a page has a private card by its absence** — the surrounding
  prose still shows a gap where one is not, and an agent may re-derive something the human
  already noted privately. Silent removal was chosen over a `<private-notes redacted/>`
  marker; this is that trade.
- **A human editing text inside an agent-notes card can be overwritten** by the next
  `write_agent_notes`. Write semantics, and the localized `edit_agent_notes` is the
  mitigation, not a fix.
- **The known decorator-node gap is inherited.** `readStateRuns` refuses to edit a block
  whose doc holds an inline decorator (`[[pageId]]`, `\(latex\)`) written by a browser.
  Unchanged here: reads are unaffected, and only an edit to such a block is refused.
- **Similarity alignment follows position, not words** — replacing a paragraph with an
  unrelated one of the same type reads as an edit. The engine's existing, documented call.

## Verification

1. `./equin build`, then `./equin check` — `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `migrations-in-sync`, `page.editor:block-data-registered`,
   `page-editor:anchor-has-decoration` and the new `annotations:audience-declared` are the
   ones that will bite.
2. `bun test plugins/page/plugins/markdown-apply/core` — the fuzzed plan invariants (a
   survivor's update never names `text` or `expanded`) must still hold under a non-page
   root. Extend `plan.test.ts` with a subtree-rooted case asserting that rows outside the
   root are neither updated nor deleted.
3. New `annotations/plugins/agent-access/e2e/agent-access-verify.ts`, modelled on
   `markdown-apply/e2e/markdown-apply-verify.ts`: build a page with prose, a private card
   and an agent-notes card; assert `read_page` omits the private card entirely, that
   `write_agent_notes` on the notes card leaves every prose block's id untouched
   (`query_db` before/after on `page_blocks.id`), and that pointing a write at a prose
   block or a private card refuses.
4. Manual: from this conversation, `append_agent_notes` onto a scratch page, then open
   `http://att-1785787278-4uy7.localhost:9000/pages` and click the card's glyph — the
   popover should list this conversation and open it.
5. `query_db` on `page_blocks_ext_agent_authors` after two writes from two conversations:
   one row, two ids, no duplicates.
