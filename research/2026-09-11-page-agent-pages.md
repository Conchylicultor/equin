# Agent pages: `<agent-page>` next to `<agent-inline>`

## Context

Today an agent can only write to a page inside an `<agent-note>` card, a blue box
placed among the page's own blocks. The user wants a second kind of agent block:

- **inline**: the existing card. Its tag becomes `<agent-inline>`.
- **page**: `<agent-page>`, a real sub-page an agent creates inside an existing page
  (an agent can never create a top-level page). The agent may write the page's whole
  content.

What the user sees:

- An agent page shows as a normal sub-page row in its parent page: icon, title, and
  a chevron that expands the page's content inline. The row keeps the agent card's
  blue tint even while collapsed.
- A chip at the row's right edge names the conversation that **created** the page.
  Clicking it opens that conversation.
- Agent pages are also tinted blue in the Pages sidebar tree (no chip there).
- A human can insert an empty agent page with `/agent-page`. It shows no chip until
  an agent writes into it; the first writer then counts as the creator.

User decisions (2026-09-11):

| Question | Decision |
|---|---|
| Rename | Only the tag becomes `<agent-inline>`. The stored type stays `agent-note`, so no migration. `<human>` is the precedent: its type is still `context`. |
| Chip | Creator only. |
| `/` menu | Yes, `/agent-page`. |
| Sidebar | Tinted too. |

## Core decision: an agent page is a `page` row with `data.author = "agent"`

- **Not a new block type.** The code tests `type === "page"` in about 46 files.
  Those include the SQL behind the sidebar, `page_id` scoping, trash, history,
  search, backlinks, the expand-inline mount and the page-type transition guard.
  A second page type would mean widening every one of those sites.
- **Stored in `data`, not in a side-table.** The marker is the page's *kind*,
  which the markdown serializer, both renderers and the write policy all read
  straight off the row.
  - Who wrote into the page is *provenance*, and that still lives in the existing
    authorship table.
  - The creator chip reads the earliest row of that table.
- **Title, icon and cover edits keep it.** Those writers spread
  `{...pageData(page), title}` and the server replaces `data` through a strict
  schema, so the field survives once `PageDataSchema` declares it.
- **The name is taken.** `apps/pages/agent-origin` already calls e2e-created pages
  (swept after 24h) "agent pages" and exports `AgentPageRow`.
  - In code, say "agent-authored page" and never reuse that symbol.
  - MCP-created pages never go through `handleCreateBlock`'s `AfterCreate` hook,
    so the sweep never marks them.
  - Keep it that way: synthesize no `Request` and no header on the MCP path.

## Markdown contract (what the agent reads and writes)

```
edit_page(parent)  — a tagless tag mints, exactly like a tagless <agent-inline>:
  <agent-page title="Findings">
    body markdown…
  </agent-page>

read_page(parent)  — afterwards it is a pointer; the content lives in its own page:
  <agent-page id="block-…" title="Findings"/>

and every other page reference now shows its title too (today it is id-only):
  <page id="block-…" title="Mental model"/>   — a human sub-page, or a link to a page

read_page / edit_page / write_agent_note (block_id = the agent page id)
  — the page's own content, `# Title` banner first; every block in it is writable.
```

- **A pointer's `title` is read-only.** It is shown so an agent can tell pages
  apart without opening each one. Editing it on a pointer is ignored, and the tool
  descriptions say so, the same stance as a TODO card's `status`. It is honoured
  only on the mint form. Ignoring beats refusing here, because a
  `write_agent_note` document can legitimately carry a title that went stale since
  the agent read it.
- **`<agent-page id="X">` with a body, or with any attribute other than `title`,
  is refused** (`ref-out-of-scope`), with the hint "X's content lives in its own
  page; pass X as `block_id`".
- **An agent page is never deleted by a markdown apply.** Leaving it out of the
  document re-homes it, the existing sub-page rule.
- **Title renames are still refused**, by `edit_page`'s title-line check.
  - That check is now load-bearing: a changed `# Title` inside an agent page would
    otherwise land as a writable heading.
  - A later rename should write the page row's `data` instead.

## Implementation

### 1. `page/editor/core`: the marker, author-from-data, tag spellings

- **`schemas.ts`.** Add `author: z.literal("agent").optional()` to `PageDataSchema`.
  Absent means the human's, which is the fail-safe reading.
- **`define-block.ts`.** Add `authorFromData?(data): BlockAuthor | undefined` to
  `BlockHandle`, and one resolver, `blockAuthorOf(handle, data)` =
  `handle.author ?? handle.authorFromData?.(parsed data)`.
  - `defineBlock` accepts the field. `ContainerBlockOptions` must not forward it,
    so an annotation can never declare both, and `annotations:parties-declared`
    stays coherent.
  - The page's declaration is a shared const, spread into both `pageBlockHandle`
    and `sub-page`'s handle, the same way `pageBlockMarkdown` is shared.
- **`markdown.ts`: data-selected tag spellings.** A new
  `BlockTag.spellings?: BlockTagSpelling<T>[]`, where each spelling is
  `{ name, data: Partial<T>, …tag options }`. The one `data` object does two jobs:
  it picks the spelling when serializing, and it is the preset merged over the
  parsed attributes when parsing. So the round trip is correct by construction.
  - `resolveTag` validates each spelling. It refuses a duplicate name, and a preset
    key the schema does not declare.
  - When parsing, it asserts the result selects its own spelling, and that a
    primary parse selects none.
  - `tagForData(h, data)` feeds `serializerFor`.
  - `tagParsersOf` iterates every spelling, so "exactly one handle claims a name"
    is unchanged.
  - Replace `markdownParseTagName` with `markdownParseTagNames(h)`, and add
    `markdownTagNameOf(h, data)`.
  - Update the consumers: the `markdown-tag-names-unique` check, the planner's
    `pageRefType`, and the policy's `tagNameOf(type, data)`.
- **`pageBlockMarkdown`.** Add one spelling:
  `{ name: "agent-page", data: { author: "agent" }, identified: true, body: "children-when-expanded" }`.
  - `parseAttrs` accepts only `title` and throws on anything else.
  - The primary `<page>` stays `serializeOnly`, so `<page id/>` still parses as
    page-link.
  - Rewrite the "parse can never mint a sub-page" comment and the editor CLAUDE.md
    section: parse now creates a sub-page only as an agent page.
- **Titles on page pointers.** The two kinds of pointer get their title two ways,
  for one reason.
  - **`<agent-page>`** emits `title` from its own `data`, through the spelling's
    `attrs`. Parse keeps it, because the mint form needs it. The planner's
    canonical-pointer check compares only the spelling's preset keys (`author`),
    so a changed or stale `title` on a pinned pointer is ignored.
  - **`<page>`** is a tag the sub-page shell and `page-link` share. `page-link`
    claims it on parse, and its title lives on another row. So `title` is an
    `annotated` attribute there: read-only, and discarded on parse. The primary
    `page` spelling and `page-link` both declare `annotated: ["title"]`.
    - This keeps the planner's shell-vs-pointer line comparison id-only, because
      annotations never reach the planner.
    - `Editor.BlockAnnotation.resolve` is handed `{ id, type, data }` rather than
      `{ id, type }` (the read already holds full rows).
    - Two providers answer it. `editor/server` gives a human `page` row its own
      `data.title`; agent pages are skipped, since their spelling emits it.
      `page-link/server` looks up the target pages' titles in one query, and a
      deleted target emits no title.
  - The web clipboard serializes without annotations, so a copied `<page>` stays
    id-only. That is the existing annotation rule.

### 2. `page/markdown-apply`: pin and mint page nodes (`core/plan.ts`)

- **Delete the "incoming `page` node" throw.** `page` is now identified, so the
  existing `ref` branch pins shells. It gains three conditions:
  - **Same kind.** A card `ref` may not pin a page row, nor the reverse. Without
    this, the card's children would be created under the page with the wrong
    `page_id`.
  - **Canonical pointer.** The incoming data must equal the stored row's
    round-trip. So `<agent-page id="H"/>` naming a human page is `unknown-ref`, and
    turning an agent page into a link is refused too.
  - **No body and no extra attribute**, else `ref-out-of-scope`.
  - A matched shell stays reposition-only.
- **Page node without a `ref`: create it.**
  - Each create's `pageId` becomes `partitionOf(j)`: the nearest *strict* ancestor
    page node being created, else the apply's `pageId`. Nested creates work too.
  - Pin the new page and everything under it as asserted-new (`pin: node.id`), so
    the aligner can never pair them with a stored row. Otherwise, re-typing a
    paragraph that already exists on the parent page inside the new body would pull
    that row into the new page with a stale `page_id`.
  - An identity claim inside a new page (an identified `ref`, or a pointer to an
    existing page) is `ref-out-of-scope`: "a row cannot move between pages".
  - Add a programming-error assert: no survivor may be re-parented under a
    created node.
  - Ranks, the rank floor, preserved-shell logic and `subtractNoise` need no change.
    The new body is its own sibling group under a new id, and a baseline document
    holds only pointers, which pin.
- **`ApplyReport.createdPageIds`**, surfaced by the tools as `created_page_ids`, so
  the agent can tell the page apart from its body.

### 3. `page/editor/server`: writing and announcing the new page

- **Nothing to unlock.** `applyPageBlockPatch` already writes each create's `pageId`
  verbatim and in parent-first order, and the new page needs no lock of its own.
- **Closed-world guard.** Every insert's `pageId` must be either the locked page or
  a page created in the same patch; otherwise 400. Web patches already satisfy
  this.
- **Announce created pages.** `ForestWriteResult.createdPageIds`, and
  `notifyStructuralChange` emits `blocksChanged` once per created page, mirroring
  deleted pages. That is what drives search, history, links and attachments.
  - This also fixes the same gap for sub-pages created by paste or duplicate.
- **The marker can never be flipped.** Every data update goes through one minting
  function, `rewriteBlockData({ type, before, next })` in `parse-block-data.ts`.
  - It returns a sub-branded `BlockDataRewrite` and asserts
    `blockAuthorOf(before) === blockAuthorOf(after)` when the type is unchanged
    (409).
  - `BlockColumnChanges.data` takes that brand, so tsc forces the forest-writer
    update paths, `handle-update-block` (which now reads `data` under the lock)
    and `replacePageContent` through it.
  - `turn-into-page` is exempt: it changes the type.
  - Creates stay free.
- **`turnIntoPage` accepts `author?: "agent"`**, for the `/agent-page` path.

### 4. `page/annotations/agent-access`: the policy and the tools

- **`markdown-apply/core/touched.ts`.**
  - `boundaryOf` receives `{ id, type, data }`, and `ChainMaps` gains `dataOf`,
    overlaid by the data of creates and updates.
  - New required input, `enclosure: WriteBoundary | "none"`: what a chain gets when
    it reaches the scope root without a declaration.
- **`policy.ts`.**
  - `writeBoundaryOf` and the policy forests use `blockAuthorOf`.
  - `enclosureOf(scope)` walks from the root's parent up through the partition,
    then the page row. It never crosses into the parent page.
  - The page row comes from the same read as the plan: `BlockScope.pageRow`, with
    the hook becoming `assertAcceptable(plan, { rows, pageRow })`.
  - **Behaviour change, stated:** an apply rooted at a nested block inside an
    `<agent-inline>` card is refused today (the walk stops at an undeclared root),
    and is accepted after this. Inside `<human>` it stays refused, now as
    "enclosed".
  - `nearestCard` becomes "the nearest row whose author is agent", over a forest
    that includes the page row. So writes inside an agent page stamp the page, and
    a newly created page is stamped as its own creator, after commit.
  - `assertNoteCard` becomes `assertAgentAuthored`, which admits a live agent page.
    `write_agent_note` on a page id replaces its whole content, and an echoed
    `# Title` banner is stripped.
  - Refusal wording derives tag names from the handles, never from literals. For
    example: "inside an `<agent-inline>` card or an `<agent-page>`".
- **`mcp-tools.ts`.** Rewrite the three descriptions: the two kinds, the mint and
  pointer forms, `created_page_ids`, and "a page's content is written by its own id".
- **The rename.** `agentNotesBlock.markdown.tag.name = "agent-inline"`. Also update:
  - the todo dispatch prompt (`task-link/server/internal/mutations.ts`)
  - the e2e scripts: `CARD_TAG`, `todo-dispatch-verify`, `annotations-verify`
  - the root `CLAUDE.md` "MCP Tools" paragraph

### 5. Web: the tint, the creator chip, `/agent-page`

- **`page/page-reference`: new `PageReference.Decoration` slot.**
  - A contribution is `{ applies(page: PageData): boolean; tint: string; chip?: ComponentType<{ pageId }> }`,
    read through `usePageReferenceDecoration(pageId, data)`.
  - It is a generic seam, and neither the sub-page nor the sidebar names "agent".
- **Consumers.**
  - `SubPageBlock` passes `tint` to `Row`'s `className` and renders `chip` at the
    right edge, always visible, left of the hover actions.
  - The sidebar (`pages-sidebar.tsx`) sets `viewOptions.tree.rowAccent` to paint
    `tint` as a full-row layer. No chip there.
- **New sub-plugin `page/annotations/plugins/agent-notes/plugins/agent-page/`, web
  only.** It declares no block type, so `annotations:parties-declared` does not
  apply.
  - It contributes the Decoration: `applies: p => p.author === "agent"`, the tint
    `bg-info/10` (the same wash as `agent-notes-frame.tsx`), and a creator chip.
  - The chip takes the earliest row of `useAgentNotesAuthors(pageId)` and renders
    it through `ConversationChip`, which the todo foot already uses. It shows a
    loading state while the conversation is still being looked up, and nothing
    when there is no author yet.
  - It contributes the `/agent-page` menu item.
- **`page/editor/web`: new `Editor.InsertAction` slot.** The `/` menu (and the
  gutter `+` menu, which is the same component) currently lists only block types
  that have a label. This slot adds items that run an action instead:
  `{ id, label, icon, aliases, run({ editor, blockId }) }`.
  - `block-type-list.tsx` shows them in the same list and ranks them with
    `filterBlockTypes`.
  - `/agent-page` turns the caret's line into an agent page in place, through
    `turnIntoPage({ title: "", author: "agent", seedChild })`.
- **The inline card's menu entry.** It keeps its label, and `agent-inline` is added
  to its aliases.

### 6. Docs

- `annotations/CLAUDE.md`: "`/agent` is the only agent-authored card" and "no list
  of writable types" become: authors resolve per row, and the page declares its own
  from `data`.
- `agent-notes/CLAUDE.md`: the umbrella now covers both kinds.
- `authorship/CLAUDE.md`: "an agent-notes card" becomes "an agent-authored block".
- `agent-access/CLAUDE.md`: the enclosure, the door, the rename.
- `markdown-apply/CLAUDE.md`: "Sub-pages are never deleted", minting, and "never
  creates a page".
- `editor/CLAUDE.md`: the page tags.
- The owner's "Page edition" instructions page (`block-7f1a2d3d…`) still says
  `<agent-note>`. It is the user's prose, so flag it to them rather than edit it.

## Stated bounds

- Sending the same minting document twice creates two pages, the same as a tagless
  `<agent-inline>` today.
- Pasting `<agent-page id="X"/>` in the web editor creates a new, empty agent page,
  because `withMintedIds` drops the ref. That matches duplicating a collapsed
  sub-page.
- A crash between commit and the authorship stamp leaves a page with no chip.
  Nothing is corrupted.
- The sidebar's existing `[Agent]` section groups the e2e-origin pages. The blue
  tint is a separate signal: an agent-authored page sits in "Mine", tinted.

## Order

1. editor/core
2. editor/server
3. markdown-apply
4. agent-access
5. web
6. rename and docs

## Verification

- **Unit tests**, via `./equin test <plugin>`:
  - `editor/core/markdown.test.ts`
    - spelling selection in both directions
    - the mint form parses to a `page` node with `author` and children
    - a pointer parses to a `ref`
    - an unknown attribute, a duplicate name, and a preset key outside the schema
      each throw
    - the round-trip fuzz includes an agent page
    - `<page>` emits an annotated `title` and drops it on parse; `<agent-page>`
      keeps it
  - `markdown-apply/core/plan.test.ts`
    - a pinned page is reposition-only
    - spelling mismatch, a body on a pointer, and an attribute on a pointer are
      each refused
    - a card ref at a page row, and the reverse, are refused
    - each create gets the right `pageId`, nesting included
    - an identical paragraph inside a new body is still a create
    - fresh ranks
    - the baseline plans no creates
  - `touched.test.ts`
    - the enclosure is `open`, `closed` or `none`
    - a nearer declaration beats the enclosure
    - a created row is open from its data
    - re-marking a page is refused on the old chain
  - `policy.test.ts`
    - writes inside an agent page are accepted and stamp the page
    - minting stamps the new page
    - the nested-root change behaves as stated
    - the door admits an agent page and refuses a human one
    - wording names both tags
  - `editor/server` patch tests
    - a create spanning both partitions
    - the closed-world 400
    - one `blocksChanged` per created page
    - flipping the author is refused through PATCH, patch, op and restore
- **`./equin check`** (type-check, plugin boundaries, docs in sync).
- **E2E.** Extend `agent-access/e2e/agent-access-verify.ts`:
  - mint with `edit_page`; `read_page` on the parent shows the pointer
  - `read_page` and `edit_page` on the new page
  - the creator stamp
  - no `page_blocks_ext_origin` row
  - a refused edit leaves the row snapshot unchanged
- **UI.** After `./equin build`, use `screenshot.ts` on a page holding an
  agent page:
  - the row is blue while collapsed and while expanded
  - the chip is on the right and opens the conversation
  - the sidebar row is tinted
  - `/agent-page` inserts one
