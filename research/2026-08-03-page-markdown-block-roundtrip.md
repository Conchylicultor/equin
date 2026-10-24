# Markdown ⇄ block forest: a lossless projection

## Context

The end goal is for agents to edit pages by writing markdown directly. The
conversion layer that would carry that already exists and is already generic —
`plugins/page/plugins/editor/core/markdown.ts` is a pure orchestrator that never
names a block type, parameterized on `handles: BlockHandle[]`, with each type
owning its mapping through `BlockMarkdown<T>` (`serialize` / `parseLine` /
`fence` / `precedence`) or a derivation from its `text` lens + `markdownPrefixes`.

It was built for one job — clipboard interop, where `text/plain` is the *lossy*
fallback beside the lossless `BLOCKS_MIME` JSON forest — and it is correct for
that job. It is not yet safe as an agent-facing document format:

- **Nine block types serialize to a blank line.** `serializerFor` falls back to
  `() => ""` for any type with neither a `text` lens nor an explicit
  `markdown.serialize` (`markdown.ts:113-115`): `callout`, `page` (sub-page),
  `page-link`, `image`, `video`, `audio`, `file`, `embed`, `bookmark`. An agent
  round-tripping a page through markdown **silently deletes all nine**. This is
  the single most important defect: everything else is fidelity, this is data loss.
- **Inline marks are dropped both ways.** `MdSerializeCtx.plain` is `plainOf`
  (concatenate, drop marks); `MdParseCtx.runs` is `runsOf`, which wraps a whole
  string as one unmarked run. `**bold**`, `[text](url)` and colors do not survive.
- **The annotation containers are deliberately one-way.** `context` / `todo` /
  `agent-notes` / `private-notes` emit a marker (`"**[Agent context]**"`) with no
  `parseLine` — `todo-block.ts:40-47` explains the choice: emitting a re-parsable
  trigger that has no parser would be a lie. The fix is to give them a real
  round-tripping syntax, not to remove the marker.
- **Two round-trip defects.** A nested fenced code block accretes indentation on
  every cycle (serialize indents every line of multi-line output, `markdown.ts:259-265`;
  the fence parser pushes body lines raw *including* that indent, `markdown.ts:177`),
  and blank lines are dropped on parse (`markdown.ts:160-163`) so empty paragraphs
  vanish.

This plan makes markdown a **lossless projection of the forest**: lenient on
parse (foreign markdown still pastes as it does today), canonical on serialize
(anything this codebase emits re-parses to the same forest). It covers items 1-5
only — applying an edited document back onto an existing page is a separate
problem, filed as `task-1785770065107-fbe9ik`.

## Stated assumptions

The user declined a clarification round; these are my calls, and each is cheap to
reverse:

1. **Coverage is total.** Every block type round-trips, via a generic `tag`
   mechanism whose *default* derives from the schema — so the nine silent-deletion
   types are fixed with zero per-plugin work, and a future block type is covered
   the day it is defined rather than the day someone remembers markdown.
2. **A sub-page body is serialize-only.** Parsing `<page id="x">…</page>` with a
   body is a **loud rejection**, not a silent drop, so authoritative sub-page
   writes can be enabled later without a syntax change. This keeps one markdown
   apply from spanning several `page_id` partitions — which is the filed task's
   problem, not this one's.
3. **Underline and color get tags** (`<u>`, `<color value="…">`), consistent with
   the block-level mechanism. `link` already has native `[text](url)` syntax;
   underline is the only mark with no delimiter (pinned by
   `inline-markdown.test.ts:260-269`), and `color` is a run attribute, not a mark.
4. **Scope is the conversion layer + the existing clipboard call sites.** No
   server-side export, no MCP tool. The server-side handle registry is already
   complete (verified: all 26 web `Editor.Block` types have a matching
   `page.block-data` contribution, with `page` sourced from editor core itself),
   so exposing this server-side later is a call-site change, not a design change.

## Design

### 1. `MarkdownContext` — one required argument, no silent degradation

Inline decorator tokens (`[[block-…]]`, `[[date:iso]]`, `[[reminder:id:iso]]`,
`\(latex\)`) are **plain substrings inside `TextRun.text`**, never a distinct run
kind (`rich-text.ts:15-17`), and always unmarked (`runs-lexical.ts:126`). A
marks-aware parser that scans delimiters blindly will corrupt them — inline LaTeX
is full of `_` and `*`. The token patterns live in each plugin's `core/tokens.ts`
but registration (`registerBlockTextExtension`) is **web-only**, so core cannot
reach them by itself.

Rather than add a registry, make it a required parameter — a caller cannot
silently forget what it must pass:

```ts
export interface MarkdownContext {
  handles: BlockHandle<unknown>[];
  /** Spans that must survive verbatim: no delimiter may open or close inside one. */
  protectedSpans: RegExp[];
}

export function parseMarkdownToForest(text: string, ctx: MarkdownContext): SerializedBlock[];
export function serializeForestToMarkdown(forest: MarkdownNode[], ctx: MarkdownContext): string;
```

Both web call sites pass `getBlockTextExtensions()`'s `deserializePattern`s
(already exported from the web barrel). A future server caller passes `[]` or its
own source, explicitly.

### 2. Inline marks (`core/inline-markdown.ts`)

`INLINE_SYNTAXES` is already the closed, core-level delimiter table, and
`inline-markdown.ts:8-11` already names this as its intended second consumer. But
`matchInlineFormat` is **not** reusable for whole-string parsing: it clamps to the
last line and requires the closer at end-of-string — it answers "did the character
I just typed close a span". Add two siblings over the same table:

```ts
export function serializeInlineMarkdown(runs: RichText, protectedSpans: RegExp[]): string;
export function parseInlineMarkdown(text: string, protectedSpans: RegExp[]): RichText;
```

Rules, each from a confirmed invariant:

- **Longest-tag-first**, matching the table's own ordering (`***` before `**`
  before `*`), which is how `***x***` yields one bold+italic run rather than nested spans.
- **Marks are a per-run set, not a tree** (`runs-lexical.ts:81` derives them via
  `hasFormat` over `MARK_ORDER`). `**a _b_ c**` flattens to three runs with mark
  *unions*; the parser must never build a nested structure.
- **Output must be `coalesce`d** — zero-length runs are illegal in canonical form
  (`rich-text.ts:184`), and adjacent identical-attribute runs must merge. Finish
  with `coalesce`; use `sortMarks` so marks land in `MARK_ORDER`.
- **Protected spans are masked before scanning** and restored after, so no
  delimiter may match inside one and no mark may be applied across one.
- `link` → `[text](url)`; `color` → `<color value="blue">…</color>`; `underline`
  → `<u>…</u>`.

Then the two ctx functions:

- `MdSerializeCtx` gains **`md(text): string`** (marks-aware) and keeps `plain`
  as the raw escape hatch. The derived serializer (`markdown.ts:111`) switches to
  `ctx.md`, as do the two explicit text serializers (`to-do`, `numbered-list`).
  `code-block` and `equation` read their own non-text fields and are untouched.
- `MdParseCtx.runs` becomes `parseInlineMarkdown`, replacing `PARSE_CTX`'s
  `runsOf` (`markdown.ts:69`).

### 3. The generic `tag` — the one real orchestrator addition

Today `parseLine` is single-line and a `fence` body is an **opaque string** handed
to `parseFenced`, so neither can produce *children*. A tag-delimited region whose
body is recursively parsed as a forest is genuinely new. Add to `BlockMarkdown<T>`:

```ts
tag?: {
  /** Defaults to the handle's `type`. */
  name?: string;
  /** Defaults to the derived projection below. */
  attrs?(data: T, ctx: MdSerializeCtx): Record<string, string | number | boolean | null | undefined>;
  parseAttrs?(attrs: Record<string, string>, ctx: MdParseCtx): T;
  /**
   * "children"              — always emit children inside the tag (containers)
   * "children-when-expanded"— emit children only when `expanded` (the mount types)
   * "none"                  — always self-closing
   */
  body?: "children" | "children-when-expanded" | "none";
};
```

**The default attr projection is what makes coverage total.** With no `attrs`
declared, scalar `data` fields become plain attributes and any non-scalar field
(callout's `iconSvgNodes`, a page `cover`) is JSON-encoded into a single `data`
attribute. Lossless by construction; a type overrides `attrs`/`parseAttrs` only
to get a prettier form.

**`serializerFor`'s void fallback changes from `() => ""` to the generic tag
serializer**, and `parserFor` gains the matching tag parser. That one change fixes
all nine silent-deletion types at once, with no per-plugin edits:

```
<callout icon="info" color="warning">
  Watch out.
</callout>

<image data='{"attachmentId":"att_9f2","width":640}'/>
```

Orchestrator changes:

- **Serialize** — a tag with a body emits open tag, children indented one level,
  close tag; the walk must then **not** re-emit those children. The walk needs a
  "this serializer consumed its children" signal, since today `walk` recurses
  unconditionally (`markdown.ts:266`).
- **Parse** — a new multi-line claiming pass beside the fence pass: a line opening
  `<name` claims through its matching `</name>` (depth-counted, so containers
  nest), and the dedented body recurses through `parseMarkdownToForest`. A
  self-closing `<name …/>` claims one line.
- **Container `markdownPrefixes` stay inert for parsing.** `derivedParsePrefixes`
  only fires for handles with a `text` lens, which a container can never have
  (`RejectTextBearing`); `todo`'s `"TODO "` drives the *typing-time wrap* only
  (`container/CLAUDE.md`). The tag pass must not accidentally revive prefix-parsing
  for containers — a `TODO ` line in pasted prose must stay prose.
- The four annotation containers drop their one-way `markdown.serialize` marker
  and declare a `tag` instead (`<context>`, `<todo>`, `<agent-notes>`,
  `<private-notes>`), each `body: "children"`.

### 4. Page tags need node ids on the walk

`<page id="…"/>` cannot be produced from a `SerializedBlock` forest: the shape is
deliberately id-less (`serialized-block.ts:8`), and a sub-page's identity **is**
its row id. So the walk's input widens:

```ts
type MarkdownNode = { type: string; data?: unknown; expanded: boolean; id?: string; children: MarkdownNode[] };
```

`IdentifiedBlock` already satisfies this exactly; `SerializedBlock` satisfies it
with `id: undefined`. `MdSerializeCtx` gains `id?: string`.

`web/serialize-blocks.ts`'s `serializeForest` — THE forest serializer, shared by
copy and duplicate — changes its return type to `IdentifiedBlock[]` and stamps
`id: block.id` in the same single walk. The paste boundary already validates
through `SerializedBlockSchema`, whose non-strict `z.object` strips the extra key,
and `withMintedIds` overwrites ids regardless.

Semantics, generic-side declarations only:

- **`page-link`** (a pointer, `{ pageId }` in its own data) → `<page id="x"/>`,
  `body: "none"`.
- **`page` / sub-page** (`pageBlockHandle`, editor core `schemas.ts:119-122`) →
  `<page id="x">…</page>` expanded, `<page id="x"/>` collapsed;
  `body: "children-when-expanded"`, `attrs: () => ({ id: ctx.id })`.
- **On parse, `<page id="x"/>` yields a `page-link`.** Minting a real sub-page
  means minting a `page_id` partition and restamping a subtree, which only the
  server's turn-into-page op knows how to do — the `sub-page` handle deliberately
  declares no `label` so it can never be created from a menu either. The `id` in
  the tag is precisely what lets the future diff/merge reconcile the tag against
  the *existing* sub-page row instead of re-minting it. Worth stating plainly in
  the code: **markdown parse alone can never mint a sub-page.**
- **A body on parse is a loud rejection** (assumption 2).

### 5. Collapse-aware, and why it is nearly free

A collapsed sub-page's children are not merely hidden — they are **not in the
forest at all**. A sub-page's children live under a *different* `page_id`
(`block-forest.ts:138`), `blocksLiveResource` filters strictly by the requested
`pageId`, and the composite store mounts a separate live feed per **expanded**
`type="page"` row (`web/internal/composition.ts`'s `deriveMounts`). Their chevron
"is not a fold at all — it drives the composite union's page MOUNT"
(`rail-seat.ts:191-195`).

So on the web forest the rule is already structurally true; `children-when-expanded`
exists to (a) choose `/>` versus `>…</page>` correctly and (b) state the rule for
any future server-side walk, which *could* load a collapsed page's rows and must
not.

For every other type, `expanded` is ignored — children are always emitted. That
preserves the existing documented decision ("markdown, copy/paste and search
indexing ignore the fold", editor `CLAUDE.md`) and is why the rule is declared on
the tag rather than derived from `handle.collapsible === "always"`: that flag's
set is `{toggle, sub-page, page-link}`, and `toggle` must keep emitting its
children when folded.

`tokensToTree` currently hardcodes `expanded: true` (`markdown.ts:225`); tag-parsed
nodes carry their own.

### 6. The two round-trip defects

- **Fence dedent.** The fence parser pushes body lines raw while the serializer
  indented them. Strip **up to** the fence token's own `indent` from each body
  line before joining (`markdown.ts:174-179`) — up to, never blindly, so genuine
  leading whitespace inside the code survives.
- **Empty paragraphs.** Blank lines stay skipped on parse — that is correct
  CommonMark and correct for foreign markdown. The asymmetry is on the serialize
  side: `page/text` declares a `tag` used *conditionally*, emitting `<text/>` for
  an empty text block and ordinary prose otherwise, so a blank line this codebase
  emits round-trips while a blank line in pasted markdown still collapses.

> **Superseded (2026-09-01), for the empty-paragraph bullet only.** An empty
> paragraph now emits as a blank line, and in our own dialect a blank line parses
> back into one; `<text/>` is kept as a parse-side alias so documents written
> under the rule above still work. Foreign pastes stay lenient. See
> [`research/2026-09-01-page-blank-line-empty-paragraph.md`](./2026-09-01-page-blank-line-empty-paragraph.md).

## Files

Core (the substance):

- `plugins/page/plugins/editor/core/markdown.ts` — `MarkdownContext`,
  `MarkdownNode`, `ctx.md`, the tag serialize/parse passes, the
  children-consumed signal, fence dedent, tag-aware `tokensToTree`.
- `plugins/page/plugins/editor/core/inline-markdown.ts` —
  `serializeInlineMarkdown` / `parseInlineMarkdown` over `INLINE_SYNTAXES`.
- `plugins/page/plugins/editor/core/define-block.ts` — `tag` on `BlockMarkdown`
  (type only; `defineBlock` already forwards `markdown` wholesale).
- `plugins/page/plugins/editor/core/index.ts` — re-exports.

Call sites:

- `plugins/page/plugins/editor/web/components/block-editor.tsx` (~508-521,
  ~586-627) and `web/components/block-forest-paste-plugin.tsx` — pass a
  `MarkdownContext`. Note the two disagree today on whether single-line plain text
  is markdown (the container path treats any non-empty text as markdown; the
  per-block path gates on `\n` via `decidePaste`). Do not "fix" that here —
  flag it if it bites.
- `plugins/page/plugins/editor/web/serialize-blocks.ts` — return `IdentifiedBlock[]`.

Per-plugin declarations (small, one `tag` each):

- `plugins/page/plugins/annotations/plugins/{context,todo,agent-notes,private-notes}/core/*-block.ts`
  — replace the one-way marker with a `tag`.
- `plugins/page/plugins/page-link/core/page-link-block.ts`,
  `plugins/page/plugins/editor/core/schemas.ts` (`pageBlockHandle`),
  `plugins/page/plugins/text/core/*` (the `<text/>` empty case).
- `callout`, `image`, `video`, `audio`, `file`, `embed`, `bookmark`: **no edit** —
  they inherit the derived tag. Add a prettier `attrs` only where it reads badly.

## Suggested order

1. `MarkdownContext` + fence dedent — mechanical, no behavior change beyond the fix.
2. Inline marks (§2) — self-contained, heavily unit-testable.
3. The generic `tag` (§3) including the void-fallback switch — this is where the
   silent deletion stops.
4. Page tags + ids (§4), collapse (§5), `<text/>` (§6).

## Verification

- `bun test plugins/page/plugins/editor/core/markdown.test.ts` and
  `inline-markdown.test.ts`. The existing suite builds its handles **locally** with
  real `defineBlock` (never importing block plugins — that would form an import
  cycle the boundary checker catches), so extend it the same way. Its current
  cases are the regression surface: prefix derivation, to-do-beats-bullet
  precedence, per-level numbered ordinals, fences with/without info string, void
  `divider`, 2-space nesting. Two of its assertions **must change** — it currently
  pins `quote` and `callout` serializing as bare paragraph text.
- Add a **round-trip property test**: for a fuzzed forest,
  `parse(serialize(forest)) ≡ forest` structurally. That is the assertion that
  actually encodes "lossless projection", and it is what would have caught the
  fence-indentation bug.
- `./equin build`, then in the app: build a page with a callout, an image, a
  context card, a nested code block and an expanded sub-page; select all, copy,
  paste into a fresh page; confirm nothing vanished and the callout keeps its tint.
- `bun plugins/page/plugins/editor/e2e/copy-paste-verify.ts` and
  `cross-block-text-selection-verify.ts` — the latter asserts the clipboard's
  literal `* ` bullet and `# ` heading output, so it is the guard that canonical
  serialization did not drift.

## Out of scope

Applying an edited markdown document back onto an existing page — matching
against the existing forest, emitting a minimal `BlockPatch`, and routing text
into surviving blocks' content docs rather than their rows (`data.text` is a
projection; `RowData` makes naming `text` in a row update a compile error). Filed
as `task-1785770065107-fbe9ik`. This plan deliberately produces the format that
task will consume, which is why §4 keeps the row id in the `<page>` tag.
