# Page instructions: wiki-scoped agent context (the CLAUDE.md of pages)

## Context

Agents learn how to work in a part of the wiki only when someone hands them the
right block id. Example: "create a new track" works only if the agent happens to
be looking at the Current tracks page. Otherwise it doesn't know that a "track" means
a page under Current tracks, or that `Track Instructions` exists. Worse, it may
write a `research/` doc, which those instructions forbid. The one global pointer we
have, `block-7f1a2d3d…` (Page edition), is hardcoded in `CLAUDE.md:42`. That can't
scale, and page ids are data, not code.

We want the same mechanism as `CLAUDE.md` files in folders, but for pages:

- A human writes an **instructions** block on a page.
- An agent receives it automatically when it reads anything under that page.
- An agent can't write under it without having received the current version.
- Instructions the human marks **global** go into every conversation from the start.

Decisions already made with the user:
- The name is `instructions`, with `rules` as an alias.
- There are two forms, an inline card and a full page, like `<agent-inline>` / `<agent-page>`.
- "Global" is an explicit toggle on the block. Its position in the tree doesn't decide it.
- An instructions **page** covers its **parent page's** subtree, like a CLAUDE.md
  sitting in a folder.
- Only global instructions are injected at conversation start, not all of them.

## Model

| | Inline card `<instructions>` | Page `<instructions-page>` |
|---|---|---|
| Stored as | new annotation block, type `instructions` | a `page` row with `data.instructions` set |
| Authored by | the human (agents may read it, never write it) | the human |
| Covers | its own page (the card's `pageId`) and every descendant page | its parent page (`pageId`) and every descendant page, itself included |
| Global toggle | the card's corner menu | the page header |
| At conversation start, if global | the full body | a pointer `<instructions-page id title/>` plus one line: "read before working under <parent title>" |
| On a read in scope | the full body | the full body |

**Staying current.** Each block is "delivered" to a conversation at a content
hash, the sha of its serialized markdown. If the human edits the instructions,
the old delivery no longer counts. The next read re-injects them, and writes are
refused again until that happens.

## Implementation

### 1. The annotation block — new plugin `plugins/page/plugins/annotations/plugins/instructions/`

Mirror `human-notes` file for file (see `human-notes/CLAUDE.md`):
- `core/instructions-block.ts`: `defineAnnotationBlock` with
  - `type: "instructions"`, `audience: "agent"`, `author: "human"`
  - `schema: z.object({ global: z.boolean().optional() })`
  - `aliases: ["rules", "guidance", "conventions"]`
  - `markdown: { tag: { name: "instructions", body: "children", identified: true } }`
  - `global` is emitted as an attribute. Agents can't write the card anyway (the
    policy treats `author: "human"` as closed), so no new rule is needed.
- `core/instructions-block.test.ts`, modeled on `human-notes-block.test.ts`.
- `server/index.ts`: `Editor.BlockData(instructionsBlock)`.
- `web/`:
  - `Editor.Block` + `Editor.BlockFrame` with an anchor, a frame using its own
    semantic-token wash, and a menu with a **Global** switch.
  - The switch's menu follows `todo/web/components/todo-menu.tsx`.
- Remove `"instructions"` and `"rules"` from the `human-notes` aliases
  (`human-notes/core/human-notes-block.ts`) so `/instructions` resolves to the new card.
- `config/page/editor/block.jsonc`: add `page.annotations.instructions:instructions`
  first in the Annotations group.

### 2. The page form — `instructions/plugins/instructions-page/`

- `editor/core/schemas.ts` `PageDataSchema`:
  - Add `instructions: z.object({ global: z.boolean() }).optional()`.
  - A `.refine` makes it exclusive with `author` (an agent page can't also be instructions).
- `pageBlockMarkdown.spellings`: add
  `{ name: "instructions-page", data: { instructions: … }, identified: true, attrs: title (+ global), serializeOnly-style parse refusal }`.
  Agents can't mint it: parsing a tagless form must throw with a clear
  message, the same way minting a human sub-page is refused.
- The page's kind is changed by one op. Generalize `handle-set-page-author.ts`
  and `apps/pages/page-author`'s toggle into a three-way **page kind** control:
  Page / Agent page / Instructions (+ a Global switch when Instructions).
  - `rewriteBlockData` already refuses a data write that flips `author`.
    Extend that refusal to `instructions`.
- Web:
  - A `PageReference.Decoration` (tint + chip) so the sidebar and the parent row show it.
  - An `Editor.InsertAction` `/instructions page`, modeled on
    `agent-notes/plugins/agent-page/web/internal/contributions.ts`.

### 3. Scope and delivery — `instructions/server/`

- A table `page_instructions_deliveries(conversation_id, block_id → page_blocks
  cascade, content_hash, delivered_at)`, with PK `(conversation_id, block_id)`.
  - Copy `agent-notes/plugins/authorship/server/internal/tables.ts`: no FK on the conversation.
  - The upsert updates `content_hash`.
- `instructionsInScope(pageId)`:
  - One recursive CTE walks up `page_blocks.page_id` from the page to the root (the
    server twin of `apps/pages/plugins/page-tree/web/ancestors.ts`).
  - It collects live `type='instructions'` cards whose `page_id ∈ chain`, and
    instructions pages whose `page_id ∈ chain` or whose `id ∈ chain`.
  - It returns them root-first.
  - It skips anything inside a human-audience subtree. Reuse agent-access's
    `redactHumanAudience` by serializing through `readBlockAsMarkdown`.
- `globalInstructions()`: every live block with `global = true`.
- `renderForDelivery(conversationId, blocks)`:
  - Serializes each block and hashes it.
  - Returns the ones whose stored hash differs, plus a `markDelivered()` callback.
- Selecting instructions pages needs `data->'instructions'`. That query is bounded by
  the `page_id` chain, so the existing `page_id` index covers it. Add no new index
  unless the verification timing says otherwise.

### 4. Hook into the page tools — `annotations/plugins/agent-access/server/internal/mcp-tools.ts`

`agent-access` imports the `instructions` server barrel. This is one feature, not
an open collection, so the direct import is allowed.
- **`read_page`**:
  - Resolve the scope with `loadBlockScope`, then call `instructionsInScope(scope.pageId)`.
  - Put the undelivered ones before the page body, in a
    `<received-instructions>` preamble that lists each block's id and which page it covers.
  - Then mark them delivered.
  - Cards already visible in the body being returned count as delivered.
- **`edit_page` / `write_agent_note`**: before planning the apply, compute scope
  for the target page.
  - If anything is undelivered, or its hash is stale, **refuse** with a 409. The
    refusal body contains those instructions, and they are marked delivered.
  - The agent retries once it has read them. The refusal itself is the delivery, so
    nothing is ever silently skipped.
- Update the three tool descriptions: what the preamble is, and why a write
  can be refused.

### 5. Global instructions at connect — generic seam in `infra/mcp`

`infra/mcp` must not know about pages, so add a collection seam:
- `Mcp.instructions({ id, render: (ctx: McpToolContext) => Promise<string | null> })`,
  a registry next to `registry.ts`.
- `handle-mcp.ts`:
  - Only when the JSON-RPC body is (or contains) `method: "initialize"`, render
    every contribution.
  - Pass the joined text as `new McpServer(info, { instructions })`, which SDK 1.29
    supports on `ServerOptions`.
  - Every other request stays as cheap as it is today.
- The `instructions` plugin contributes the page section:
  - A short fixed paragraph: pages carry instructions, `read_page` delivers them, and
    writes refuse until you've received them.
  - Then global cards in full and global pages as pointers.
  - Global cards are marked delivered for `conversationId`.
- Risk: Claude Code may truncate long server instructions. That's why global pages
  are pointers. Log the rendered length.

### 6. Docs and data

- `CLAUDE.md:42`: replace the hardcoded `block-7f1a2d3d…` sentence with the rule
  in one line. Pages may carry instructions, which are delivered with reads, and
  global ones arrive at conversation start.
- `plugins/page/plugins/annotations/CLAUDE.md`: add the row to the audience/author
  matrix, plus the scope rule.
- **Content conversion is the user's action.** Agents can't write human prose.
  - Mark `Track Instructions` (under Current tracks) as an instructions page, **global**.
    Its first line should say what a track is, so "create a new track" resolves anywhere.
  - Mark `Page edition` as an instructions page, **global**.
  - The implementing agent verifies both on its own worktree DB fork, and hands
    the user the exact clicks.

## Verification

- `./equin test plugins/page/plugins/annotations/plugins/instructions`:
  - The block handle test.
  - `instructionsInScope` against `createTestDb` (`database/db-test-fixture`):
    card on an ancestor, page form covering its parent, a sibling subtree that isn't
    covered, a private card being redacted, and a stale hash after an edit.
- `./equin test plugins/page/plugins/annotations/plugins/agent-access`:
  - The policy and tool tests for the write refusal, then success after delivery.
- `./equin test plugins/infra/plugins/mcp`: `instructions` appears only on `initialize`.
- Extend `agent-access/e2e/agent-access-verify.ts`:
  - Build a Root → Tracks (with instructions page) → Track tree in the worktree.
  - `read_page` on Track returns the preamble. A second read doesn't.
  - Edit the instructions, and `edit_page` is refused until the next read.
- Manual:
  - `./equin build` (in the background) generates the migration.
  - Start a conversation against the worktree and confirm the MCP `initialize` result
    carries the global section (`curl` a JSON-RPC initialize at `/api/mcp/<id>`).
- `./equin check`: plugin boundaries (agent-access → instructions, mcp stays
  page-free), `annotations:parties-declared`, docs in sync.
