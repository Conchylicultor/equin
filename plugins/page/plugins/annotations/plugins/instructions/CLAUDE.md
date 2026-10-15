# instructions

The `CLAUDE.md` of a part of the wiki. A person writes **instructions** on a page;
every agent reading anything under that page receives them, cannot write there
until it has received the current version, and — when the person marks them
**global** — gets them at the start of every conversation.

Design: [`research/2026-09-17-page-agent-instructions.md`](../../../../../../research/2026-09-17-page-agent-instructions.md).

Two forms, like `<agent-inline>` / `<agent-page>`:

| | Inline card `<instructions>` | Page `<instructions-page>` |
|---|---|---|
| Stored as | block type `instructions` (this plugin's `core`) | a `page` row with `data.instructions: true` ([`instructions-page`](plugins/instructions-page/CLAUDE.md)) |
| Made with | `/instructions` (aliases `/rules`, `/guidance`, `/conventions`) | `/instructions page`, or the page header's kind control |
| Covers | the page it sits on, and every page below | its PARENT page, and every page below, itself included (a top-level one covers only itself) — plus the page of every link-to-page block pointing at it |
| Global switch | the card's rail menu | the page header's kind control |

Both are the human's words: `audience: "agent"`, `author: "human"`. An agent reads
them and never writes them, even nested inside its own card or page.

## The card

A void container like every annotation (see [`page/annotations`](../../CLAUDE.md)),
with one field: `global?: boolean`. It is the family's first payload that is not
`{}`, and it is not appearance — it is the card's reach — so the family's "no
per-instance appearance" rule still holds.

- **Tint** `bg-primary/10`, the one semantic hue the family had not used; the
  instructions page's row wears the same wash.
- **Corner name** `Instructions`, or `Global instructions`.
- **Rail menu** one switch, **Global**, writing the card's data through
  `api.update`.
- **Markdown** `<instructions id="…" global="true">…</instructions>` — `global` a
  plain attribute emitted only when true, not the derived JSON `data` blob, so an
  agent sees a card's reach at a glance. Identified, for the reason every
  agent-facing card is.

`human-notes` gave up the instruction words (`instructions`, `rules`, `guidance`,
`conventions`) so `/rules` offers one card, this one.

## Scope and delivery (`server/`)

The API the agent-facing page tools and the MCP connect-time instructions consume.
It names no tool and no MCP concept — it answers "which instructions cover this
page", "which are global", and "which has this conversation not received yet".

```ts
instructionsInScope(pageId, executor?): Promise<InstructionsRef[]>   // root-first
globalInstructions(executor?): Promise<InstructionsRef[]>
renderInstructions(refs, executor?): Promise<RenderedInstructions[]>
renderForDelivery(conversationId, refs, executor?): Promise<InstructionsDelivery>
  // { rendered, pending, markDelivered() }
markInstructionsDelivered(conversationId, blocks, executor?): Promise<void>
instructionsContentHash(markdown): string

InstructionsRef = { id, form: "card" | "page", global, title (page only),
                    covers: { pageId, title } }
RenderedInstructions = InstructionsRef & { markdown, contentHash }
```

- **Scope** is one recursive CTE up `page_blocks.page_id` from the page to the
  root, collecting live cards whose `page_id` is on the chain and instructions
  pages whose `page_id` or own `id` is — or that a live link-to-page block
  (`page-link`) on the chain points at, covering the link's page as if the page
  lived there. An inline `[[page]]` mention is not followed: it names a page, it
  does not place one. Ordered root-first (general before particular), cards
  before pages within one covered page; a block reached twice is returned once,
  at its root-most cover (deliveries are keyed by block id).
- **Withheld stays withheld.** A block whose ancestors (within the page it is
  displayed in) include a human-audience row — a `/private` card — is never in
  scope, global or not; a linked instructions page is withheld when either the
  link or the page's own placement is. The type set is `humanAudienceTypes()` from the
  [`annotations`](../../CLAUDE.md) umbrella's server barrel, the same predicate
  `agent-access` redacts with. It lives on the umbrella rather than in
  `agent-access` because `agent-access` imports THIS plugin, so this plugin cannot
  import it back.
- **Rendering** is `markdown-apply`'s `readBlockAsMarkdown`, redacted through the
  same predicate: a card as its content (its children), a page as its whole
  document, banner included — exactly what `read_page` would return for that id.
- **A delivery counts at a content hash.** `page_instructions_deliveries`
  `(conversation_id, block_id)` → `content_hash` (sha256 of the rendered
  markdown). `renderForDelivery` renders, hashes and compares; a block with no row
  or a different hash is `pending`. Nothing is recorded until the caller runs
  `markDelivered()` — rendering is not handing over. A text edit inside a redacted
  private card does not change the hash, because it is not in the markdown.
- **The table** follows `page_blocks_agent_authors`: composite PK as the upsert
  target, `block_id` cascades, no FK on `conversation_id`. It grows with
  conversations, so a 30-day TTL sweep bounds it; a swept row only means a
  long-lived conversation receives the same instructions once more.

`globalInstructions` scans `page_blocks` for the global marker once per
conversation start, with no index behind `data->>'global'` — add one only if a
measurement asks for it.

## Why the page form's data is flat

`PageData` carries `instructions: true` and `global?: boolean` as top-level keys,
not `instructions: { global }`. A markdown spelling is selected by a PRESET of
literal discriminator values (`BlockTag.spellings`), and `instructions: true` is
a literal where an object is not. The two keys are read and written only through
`pageKindOf` / `withPageKind` (`page/editor` core), so no writer handles them one
at a time; exclusivity with `author`, and `global` requiring `instructions`, is
`BlockHandle.refine`, because zod 3's `.refine` would strip the schema of
`.shape` and `.strict()`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Instructions block type: a void CONTAINER whose soft-tinted box wraps blocks of any type, holding the human's standing instructions to agents working under the page it sits on — delivered to them with their reads, and to every conversation at its start when the card's Global switch is on. Instructions: registers the card's `data` schema ({ global? }) at the server write boundary, and owns page_instructions_deliveries — which instructions each conversation has received, at which content hash — with the scope queries (instructionsInScope, globalInstructions) and the render-hash-compare delivery helpers the agent-facing page tools and the MCP connect-time instructions consume.
- Web:
  - Contributes:
    - `Editor.Block` "instructions" → `ContainerNoRow`
    - `Editor.BlockFrame` "instructions" → `InstructionsFrame`
  - Uses:
    - `page/container.ContainerBackdrop`
    - `page/container.ContainerCornerLabel`
    - `page/container.ContainerNoRow`
    - `page/editor.Editor`
    - `primitives/css/control-panel.ControlPanel`
- Server:
  - Contributes: `page.block-data` "instructions"
  - Uses:
    - `database.db`
    - `database.DbExecutor`
    - `infra/retention.defineRetention`
    - `page/annotations.humanAudienceTypes`
    - `page/editor._blocks`
    - `page/editor.Editor`
    - `page/markdown-apply.readBlockAsMarkdown`
  - DB schema: `plugins/page/plugins/annotations/plugins/instructions/server/internal/tables.ts`
  - Exports (types):
    - `InstructionsDelivery`
    - `InstructionsRef`
    - `RenderedInstructions`
  - Exports (values):
    - `_pageInstructionsDeliveries`
    - `globalInstructions`
    - `instructionsContentHash`
    - `instructionsInScope`
    - `markInstructionsDelivered`
    - `renderForDelivery`
    - `renderInstructions`
  - Register: `defineJob('retention.page_instructions_deliveries')`
- Core:
  - Uses:
    - `page/annotations.defineAnnotationBlock`
    - `ui/icons.symbol`
  - Exports (types): `InstructionsData`
  - Exports (values):
    - `instructionsBlock`
    - `instructionsDataSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by: `page/annotations/agent-access`
- Sub-plugins:
  - **`instructions-page`** — Instructions pages in the page editor: a sub-page whose data marks it `instructions: true` is tinted with the instructions card's wash wherever it is referenced (its row in the parent page, the…

<!-- AUTOGENERATED:END -->
