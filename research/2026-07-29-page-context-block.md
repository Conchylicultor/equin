# `/context` — a card for agent-targeted instructions

> **SUPERSEDED IN PART — read this first.** Stage 1 below designed the card as a
> TEXT-BEARING collapsible block with an editable title row, so the chevron would
> have a line to hang on. **That model was wrong and was withdrawn.** It made the
> card's first line permanently `text`-typed (so it could never be a heading), and
> Enter in the title minted a second sibling card wherever
> `splitChildWhenExpanded`'s policy did not apply — caret at offset 0, or a
> collapsed card — because `keystroke-intent.ts` resolves
> `tailType = asChild ? childType : (siblingType ?? node.type)`.
>
> What shipped instead is the **callout's** model: a VOID container
> (`z.object({})`, no text, all displayed content is its children), built on a new
> extracted primitive, `plugins/page/plugins/container/`, which both `callout` and
> `context` now compose. Collapsibility was dropped with the header row and is
> filed as its own task (`task-1785367889998-8d2z8z`), gated on a UX discussion.
>
> The live design lives in `plugins/page/plugins/container/CLAUDE.md` and
> `plugins/page/plugins/context/CLAUDE.md`. Below, the *Context* section and
> Stage 2 remain accurate; Stage 1's block design does not.

## Context

Pages are becoming the place where work is described, and `/prompt` blocks already
launch agents from them. What is missing is a way to put **standing instructions
for agents** into a page — coding conventions, "always run X first", domain
glossary — visually separated from the prose a human is reading, and collapsible
so a long instruction block does not dominate the page.

The ask: a `/context` command inserting a **collapsible card that holds arbitrary
nested sub-blocks**, like the existing `callout` container but with a chevron.

### The one fact that shapes the scope

**Nothing feeds page content to an agent today.** Verified:

- `serializeForestToMarkdown` (`plugins/page/plugins/editor/core/markdown.ts:242`)
  has exactly three callers, all browser clipboard (`block-editor.tsx:599`, `:702`,
  `block-forest-paste-plugin.tsx:61`).
- A `/prompt` launch sends **only that block's own text** — `prompt-block.tsx:35`
  (`plainOf(data.text)`) → `createTaskFromPromptBlock`
  (`prompt/plugins/link/server/internal/mutations.ts:28`) sets
  `description: body.prompt` and nothing else. That plugin's own comment
  (`prompt-block.tsx:26`) already flags feeding the surrounding page as future work.
- `serializePageContent` is consumed only by Pages version history.
- The only agent-reachable path is the generic `query_db` MCP tool over raw
  `page_blocks.data` JSON.

So **Stage 1 alone gives agents nothing.** It is still the right first step (the
block must exist before anything can deliver it), but the plan below adds Stage 2
to actually close the loop. Stage 2 is separable — cut it and Stage 1 still ships
a complete, useful editor feature.

---

## Stage 1 — the block

### Design in one line

`context` = the `toggle` block's handle flags (own header row, chevron,
Enter-nests-a-child) + the `callout` block's `Editor.BlockFrame` contribution
(a box painted around its whole visible subtree), and **not** an `anchor`.

Why not model it on `callout` directly: a callout is `anchor: true`, meaning it
renders no line of its own — and therefore has nowhere to hang a chevron, which is
exactly why it declares `collapsible: "never"`
(`plugins/page/plugins/callout/core/callout-block.ts:44`). Collapsibility
*requires* a header row. Once the header row exists, making it an editable title
costs nothing and buys: a meaningful collapsed state, and free rendering in
`read-only-view` / version-history through its generic `TextLikeBlock` arm.

### Why this needs zero editor-core changes

Verified against the editor:

| Requirement | Existing mechanism |
|---|---|
| Is a container (box wraps its subtree) | Contribute `Editor.BlockFrame`. `useFramedBlockTypes()` (`web/slots.ts:111`) derives containerhood purely from registered `match` strings. `anchor` on the contribution is **optional** (`web/slots.ts:43`). |
| Renders its own header row | `BlockRow` branches on the **core** handle field `anchor === true` (`web/components/block-row.tsx:156`). No `anchor` → the ordinary-row branch (`:201-292`): chevron + gutter rail + `Editor.Block.Dispatch`. |
| Chevron even when empty | `showChevron = handle?.collapsible !== "never" && (hasChildren \|\| handle?.collapsible === "always")` (`block-row.tsx:104`). |
| Enter in the header creates the body | `splitChildWhenExpanded: { childType: "text" }`, resolved in `keyboard-plugin.tsx:151` + `internal/keystroke-intent.ts:187`. |
| Read-only / history rendering | `read-only-blocks.tsx:416-429` paints **any** framed type's `BlockFrame` as an `Overlay behind`, `inset: 0`. Text-bearing non-anchor blocks flow through the generic `TextLikeBlock` arm. Nothing to add. |

### Files to create — `plugins/page/plugins/context/`

A flat leaf plugin, same shape as `toggle`/`callout`. No sub-plugins: this is one
block type with one appearance, not a set of independently-swappable parts.

**`core/context-block.ts`** — mirror `toggle/core/toggle-block.ts` byte-for-byte in
shape:

```ts
export const contextDataSchema = textBlockSchema({});

export const contextBlock = defineBlock({
  type: "context",
  schema: contextDataSchema,
  label: "Context",
  icon: MdSmartToy,                       // from react-icons/md
  aliases: ["agent", "instructions", "ai", "agents", "guidance"],
  empty: () => ({ text: [] }),
  placeholder: "Context for agents…",
  collapsible: "always",
  splitChildWhenExpanded: { childType: "text" },
  resetToOnBackspaceAtStart: "text",
  breakOutOnEmptyEnter: "text",
  markdown: { serialize: … },             // see below
});
```

Deliberately **absent**, each for a reason:

- **no `anchor`** — it renders its own header row (that is where the chevron lives).
- **no `wrapOnConvert`** — `/context` **retypes** the block (its text becomes the
  card title), like `toggle`. Callout wraps because it is void and has no title to
  put the text in; here wrapping would leave the title blank and move the caret
  into a child. Retyping keeps the caret where the user is typing.
- **no `markdownPrefixes`** — every short prefix worth having is taken, and a
  `/context`-only entry point is the ask.
- **no `gutterFirstLineCenter`** — the frame is an `absolute` overlay
  (`left/right/top/bottom`, see `CalloutFrame`), so it adds **nothing to the flow**;
  the header row's first line sits exactly where any text row's does. Declaring one
  would introduce a drift the default already avoids.

**`core/index.ts`** — re-export `contextBlock`, `contextDataSchema`.

**`web/index.ts`** — two contributions, mirroring `callout/web/index.ts`:

```ts
Editor.Block({
  id: contextBlock.type,
  match: contextBlock.type,
  block: contextBlock,
  component: BlockTextRenderer,   // VERBATIM — see below
}),
Editor.BlockFrame({
  match: contextBlock.type,
  component: ContextFrame,        // no `anchor` — this is not an anchor type
}),
```

`BlockTextRenderer` is reused **unchanged**, not wrapped. Its docblock
(`web/components/block-text-renderer.tsx:7-16`) states the rule: every text block
type registering *this same function* is what makes converting between them
reconcile in place, preserving the live Lexical instance and caret. A bespoke
wrapper component would remount on every `text → context` conversion and drop the
caret mid-`/context`.

**`web/components/context-frame.tsx`** — mirror `callout/web/components/callout-frame.tsx`:

```tsx
export function ContextFrame({ inset }: BlockFrameProps) {
  return (
    <div
      className="absolute rounded-md border border-dashed border-border bg-muted/40"
      style={{ left: inset, right: 0, top: 0, bottom: 0 }}
    />
  );
}
```

Three constraints from `BlockFrameProps`' docblock (`web/types.ts:110-131`) and the
editor's `CLAUDE.md`, all honoured here:

- **Appearance only, no content of its own.** (So: no eyebrow label inside the
  frame — the frame is a paint layer, and it is `pointer-events-none` anyway.)
- **No horizontal offset beyond `inset`** — enclosed rows seat their hover rail
  against an edge the surface computed; shifting the flow strands them.
- **No `h-full`** — absolute insets only, or vertical bleed shifts the box instead
  of growing it.

The dashed border is what distinguishes it from a callout (solid tint, no border)
and reads as "meta, not prose". Tokens only — `border-border`, `bg-muted`,
`rounded-md` — no ad-hoc radius/color (`no-adhoc-radius`, `no-adhoc-surface`).

**`server/index.ts`** — one line, mirroring `callout/server/index.ts`:
`contributions: [Editor.BlockData(contextBlock)]`. This is what registers the zod
schema at the write boundary (`server/internal/parse-block-data.ts:23` →
`handle.schema.strict().safeParse`) and what the
`page.editor:block-data-registered` check enforces.

**`package.json`**, **`CLAUDE.md`** — standard.

### Markdown serialization

Internal copy/paste is lossless via the `BLOCKS_MIME` JSON forest
(`block-editor.tsx:598`); `text/plain` markdown is the **external** projection
only. So a one-way serializer costs nothing internally and is worth having — it is
what makes a context card recognizable if the page's markdown ever reaches an
agent (and it is the exact function Stage 2 reuses):

```ts
markdown: {
  serialize: (data, ctx) => `**[Agent context]** ${ctx.plain(data.text)}`.trimEnd(),
}
```

Children serialize generically, indented two spaces under it
(`serializeForestToMarkdown`'s `walk`). No `parseLine` / `parseFenced`: a
markdown round-trip back into a card is not needed (internal paste uses the JSON
forest), and claiming a parse prefix risks colliding with real prose.

### Risks and edge cases

- **Empty card.** A childless `context` gets a frame over its own row alone
  (`computeFrameSpans`, `block-frames.ts:64`) — a real one-line box, because the
  row is an ordinary row with a real height. The childless-anchor 0px-ghost hazard
  is anchor-specific and does not apply.
- **Collapsed card.** Frame still spans its own row (documented: the box must not
  blink out on collapse). The title stays visible. Correct by construction.
- **Nesting.** Frames may nest and never partially overlap (`block-frames.ts:63`),
  so a context card inside a callout — or vice versa — is already handled.
- **Deleting the header** deletes the container; children are promoted by the
  generic machinery, same as `toggle`. No `unwrap` rung is needed (that exists for
  anchors, whose first child would otherwise adopt its siblings).
- **`page-editor:anchor-has-decoration`** does not apply — it fires only for
  handles declaring `anchor: true`.

---

## Stage 2 — actually delivering it to agents

> **NOT IN SCOPE — cut by the user on 2026-07-29.** Stage 1 shipped alone. This
> section is kept as the recorded design for the follow-up, and is the reason the
> Stage 1 markdown serializer exists (Stage 2 reuses it rather than adding a
> second rendering path). Until this lands, a context card is **inert for agents**:
> it is stored and rendered, but nothing feeds it to one.

Make a `/prompt` launch on page P include P's context cards in the task
description.

**Do not** have the prompt plugin import the context plugin — that names a
specific contributor and violates collection-consumer separation. Invert it:

1. **`prompt/plugins/link`** defines a server contribution slot, e.g.
   `PromptLaunch.Preamble: (pageId: string) => Promise<string | null>`, and in
   `createTaskFromPromptBlock` (`server/internal/mutations.ts:28`) awaits every
   contribution, drops the nulls, and prepends the joined result to `description`
   inside a `<page_context>` delimiter. It never learns that `context` exists;
   any future plugin can inject page-scoped agent context the same way.
2. **`plugins/page/plugins/context/server`** contributes one: load the page's
   blocks (`_blocks` from the editor server barrel), take the `context`-typed
   roots, build each subtree with `serializeSubtree` (editor `core/block-forest.ts`),
   and render with `serializeForestToMarkdown(forest, Editor.BlockData.getContributions())`
   — reusing the Stage 1 serializer, no second rendering path.

Note `serializeForestToMarkdown` currently lives in editor `core` and takes
handles as a parameter, so it is already server-callable; confirm the
`BlockHandle<unknown>[]` → `Handle[]` assignability at implementation time.

Nothing about the task title path changes (`synthesiseTitleFallback` /
`scheduleTaskTitleUpdate` should keep seeing the raw prompt, not the preamble —
pass `body.prompt` to both, as today).

---

## Verification

1. `./equin build` from the worktree, then open
   `http://att-1785350257-w9yd.localhost:9000/pages`.
2. `./equin check` — `page.editor:block-data-registered`,
   `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`, and the
   layout/radius/surface lint rules are the ones that will bite.
3. Manual pass on a page: `/context` on an empty block → card with chevron; type a
   title; Enter → body nests as a child; Tab/Shift-Tab inside; collapse → title and
   box persist, children hidden; reload → all persisted; delete → children promoted.
4. **E2E script** at `plugins/page/plugins/context/e2e/context-container-verify.ts`,
   modelled on `callout/e2e/callout-container-verify.ts` (which is the best
   executable spec in the repo for container behaviour). Assert, against the real
   surface: the frame box spans header + subtree; the chevron exists on an empty
   card and collapsing hides children while the box survives; Enter in the header
   yields a **child**, not a sibling card; a nested card inside a callout paints
   both boxes. Run with
   `bun plugins/page/plugins/context/e2e/context-container-verify.ts`.
5. If Stage 2 lands: launch a task from a `/prompt` block on a page with a context
   card, then check the task description via
   `query_db` (`SELECT description FROM tasks ORDER BY created_at DESC LIMIT 1`)
   for the `<page_context>` section.
