# Typed per-block markdown + runs-only text (fix empty copy/paste structurally)

## Context

Copy/paste in the Pages app produces empty blocks. Confirmed root cause (live incident on
`block-1783499251678-v8u0rw`, block `ae94d246…` = `{"text": []}` with a Y.Doc of three
whitespace-only paragraphs):

1. Block-selection copy writes two clipboard flavors (`block-editor.tsx:495-506`): the full
   forest JSON under `BLOCKS_MIME`, and markdown via `blocksToMarkdown` as `text/plain`.
2. `blocksToMarkdown` (`web/markdown-blocks.ts:205-210`) duck-types `d.text` as
   `typeof d.text === "string" ? d.text : ""`. Since the inline rich-text migration
   (June 16, `eebb9923c`), `data.text` is `TextRun[]` — every copied line serializes empty.
3. Pasting with the caret INSIDE a block bypasses the container `onPaste` (the only handler
   that understands `BLOCKS_MIME`); Lexical's default RichText paste dumps the
   whitespace-only `text/plain` into ONE block's Y.Doc, breaking one-paragraph-per-block.

The defect class — generic code dereferencing untyped block `data` — has two more live
instances (Story app: `outline-to-bullets.ts:23` → `"[object Object]"` corruption;
`text-content.tsx:16` → React "Objects are not valid as a React child" crash) and one latent
serializer bug (equation copies as `$$` with no expression: central code reads `d.text`, the
type stores `d.expression`).

**Redesign goal:** the block type is the ONLY code that dereferences its own `data`, typed
against its own zod schema — markdown serialize/parse become per-type functions on
`defineBlock`, a derived typed text lens replaces raw `data.text` reads, and the legacy
`string | RichText` union is retired (a deliberate reversal of the recorded "no DB
migration" decision in `rich-text.ts:6-9` / `text-data.ts:10-13` — those comments get
updated). Scope decisions (user-approved defaults): include paste unification; backfill
migration; plain-text markdown fidelity now (mark-aware later, without signature changes).

Key wiring fact: web and server share the SAME `defineBlock` instances via each block
plugin's `core/` barrel (web `Editor.Block` slot; server `Editor.BlockData` registry), so a
per-type `markdown` option on the handle is available to both runtimes by construction.

---

## Shared new API (Stage 1)

New file **`plugins/page/plugins/editor/core/markdown.ts`** — pure orchestrator, replaces
`web/markdown-blocks.ts` (moves to core: it's pure, the handles live in core, tests are
co-located bun:test, and a future server-side markdown import/export reuses it; stays
parameterized on `handles: BlockHandle[]` so no import cycle).

```ts
export interface MdSerializeCtx {
  /** Flatten runs (or a legacy string) to plain text. Marks dropped today; a future
   *  ctx.md(runs) adds **/_/`/[]() rendering WITHOUT changing per-type signatures. */
  plain(text: RichText | string): string;
  /** 1-based position within this block's consecutive same-type sibling run. */
  ordinal: number;
}
export interface MdParseCtx {
  /** Wrap plain inline text as runs (future: parse inline marks → runs). */
  runs(text: string): RichText;
}
export interface BlockMarkdown<T> {
  /** Emit this block as markdown line(s), NO indentation (central indents, incl.
   *  splitting multi-line output). Default for text-bearing: outputPrefix + ctx.plain. */
  serialize?(data: T, ctx: MdSerializeCtx): string;
  /** Claim one line → this type's data payload, or null to decline.
   *  Default for text-bearing: markdownPrefixes match → {...empty(), text: ctx.runs(rest)}. */
  parseLine?(line: string, ctx: MdParseCtx): T | null;
  /** Fenced multi-line: central accumulates open→close, then parseFenced(info, body). */
  fence?: { open: string; close: string; parseFenced(info: string, body: string, ctx: MdParseCtx): T };
  /** parseLine dispatch order, desc — only to disambiguate overlapping prefixes
   *  (to-do beats bullet for "- [ ] x"). Default 0. */
  precedence?: number;
}
export function serializeForestToMarkdown(forest: SerializedBlock[], handles: BlockHandle[]): string;
export function parseMarkdownToForest(text: string, handles: BlockHandle[]): SerializedBlock[];
export function defaultTextHandle(handles: BlockHandle[]): BlockHandle | undefined; // moves here
```

`BlockMarkdown<T>` with `T = z.infer<S>` is the correctness-by-construction core:
`toDo.markdown.parseLine` must return `{text: RichText; checked: boolean}`;
`equation.markdown.serialize` reads `d.expression`. The June-16-style migration would have
been a compile error in each type's own function, not a silent `""`.

### Typed text lens + schema brand

`core/text-data.ts` — brand at the schema TYPE level (compile-time only; `z.infer<S>` stays
clean):

```ts
declare const TEXT_BEARING: unique symbol;
export type TextBearingSchema = { readonly [TEXT_BEARING]: true };
export function textBlockSchema<T extends z.ZodRawShape>(extra: T) {
  const schema = z.object({ text: RichTextSchema, ...extra });
  return schema as typeof schema & TextBearingSchema;
}
```

`core/define-block.ts` — conditional lens on the brand, installed at runtime off the
already-derived `acceptsText`:

```ts
type TextLens<S> = S extends TextBearingSchema
  ? { text(data: z.infer<S>): RichText } : { text?: undefined };
export function defineBlock<S extends AnyZodObject>(
  opts: DefineBlockOpts<S> & { markdown?: BlockMarkdown<z.infer<S>> },
): BlockHandle<z.infer<S>> & TextLens<S>
// runtime: text: acceptsText ? (d) => runsOf((d as {text?: unknown}).text) : undefined
```

`handle.text(data)` is THE single typed reader. It coerces via `runsOf`, so it is correct
BEFORE Stage 2 lands (the union becomes internal to the lens). `BlockHandle<T>` gains
optional `text?: (data: T) => RichText` and `markdown?: BlockMarkdown<T>`.

### Central resolution (generic — never names a block type)

- `outputPrefix(h)` = first `markdownPrefixes` entry not starting with `` ` `` or `[`.
- `serializerFor(h)`: explicit `markdown.serialize` → else lens-derived
  `outputPrefix + ctx.plain(h.text(d))` → else `() => ""` (void type, blank line — current
  lossy-external behavior preserved).
- `parserFor(h)`: explicit `markdown.parseLine` → else lens + prefixes derived → else never
  claims.
- `parseMarkdownToForest` loop: indent/content per line → fence accumulation
  (`h.markdown?.fence`) → non-default handles sorted by `precedence` desc, first non-null
  wins → `defaultTextHandle` fallback (`text: ctx.runs(content)`) → `tokensToTree`
  (unchanged indentation→nesting).
- `serializeForestToMarkdown` keeps the current walk (per-sibling-list ordinal reset,
  `"  ".repeat(depth)`, multi-line indent-split) calling `serializerFor`.

`markdownPrefixes` keeps its dual role deliberately: live-typing auto-convert
(`markdown-shortcut-plugin.tsx:47`) AND the derived markdown default read the same list —
one source, no divergence. `quote` still declares none (`> ` is claimed by toggle) and
round-trips as plain text, unchanged.

---

## Stage 1 — typed markdown + lens + bug fixes (lands alone; fixes the reported bug)

**Create:** `plugins/page/plugins/editor/core/markdown.ts` (API above).

**Modify (editor core):**
- `core/define-block.ts` — `markdown?` opt + `text` lens + `TextLens<S>` return.
- `core/text-data.ts` — `TextBearingSchema` brand.
- `core/index.ts` — export the new symbols.

**Modify (editor web):**
- Delete `web/markdown-blocks.ts`; repoint its importers to `../../core`:
  `web/components/block-editor.tsx` (`:60-64,501,562,593,601,609-612`) and
  `web/internal/use-insert-block-below.ts:21`.

**Per-type `markdown` declarations — only 5 types; everything else derives:**
- `code-block/core/code-block.ts` — fence open/close ```` ``` ````,
  `parseFenced: (info, body) => ({ code: body, ...(info ? { language: info } : {}) })`,
  `serialize: (d) => "```" + (d.language ?? "") + "\n" + d.code + "\n```"`.
- `to-do/core/to-do-block.ts` — `precedence: 10`;
  `serialize: (d, ctx) => \`- [${d.checked ? "x" : " "}] \` + ctx.plain(d.text)`;
  `parseLine`: `/^[-*+]?\s*\[([ xX])\]\s+(.*)$/` → `{text: ctx.runs(m[2]), checked}`.
- `numbered-list/core/numbered-list-block.ts` —
  `serialize: (d, ctx) => \`${ctx.ordinal}. \` + ctx.plain(d.text)`;
  `parseLine`: `/^\d+[.)]\s+(.*)$/` (literal number discarded, positional at render).
- `math/plugins/equation/core/equation-block.ts` — `serialize: (d) => "$$" + d.expression`;
  `parseLine: (l) => l.startsWith("$$") ? { expression: l.slice(2).trim() } : null`.
  (Fixes the expression-loss-on-copy bug.)
- `divider/core/divider-block.ts` — `serialize: () => "---"`;
  `parseLine: (l) => l.trim() === "---" ? {} : null` (void: never injects a `text` key —
  closes the paste-side void-text-injection bug the 20260710 repair migration cleaned up).

**Same-class reader fixes (Story app):**
- `apps/story/plugins/story-core/core/outline-to-bullets.ts:23-24` — replace the
  `as {text?: string}` cast with `plainOf(...)` (import from
  `@plugins/page/plugins/editor/core`).
- `apps/story/plugins/content/plugins/text/web/components/text-content.tsx:16` — replace the
  string cast with the lens: `plainOf(textBlock.text(result.data))`.

**Tests (bun:test, co-located):**
- `core/markdown.test.ts` — round-trips via REAL `defineBlock` handles: text; heading
  prefixes; bullet multi-prefix parse / single-prefix serialize; to-do both states +
  precedence over bullet; numbered sequential + per-level reset; toggle `> `; code fence
  multi-line + language; equation `$$expr`; divider `---` (assert parsed data has NO `text`
  key); nested indentation → tree; quote/callout serialize as plain text.
- `core/define-block.test.ts` — extend: lens coerces `"" → []`, `"x" → [{text:"x"}]`, runs
  pass-through; non-text handle has `text: undefined` (runtime) and `text?: undefined`
  (type-level).

## Stage 2 — retire the `string | RichText` union

Normalize-at-boundary, NOT reject-loudly: history restore (`replacePageContent` →
`parseBlockData` at `page-content.ts:161`) replays pre-migration `entity_versions` snapshots
whose `data.text` is a string — the boundary must canonicalize them or restore 400s.
`runsOf`/`plainOf` keep their string branches permanently (history blobs, external input);
what retires is the persisted `page_blocks` shape + the write path.

**Modify:**
- `core/rich-text.ts` — `RichTextSchema` → `z.array(TextRunSchema)`; rewrite header comment
  `:6-9` (drop "no DB migration"; document the boundary normalizer + backfill as the seam).
- `core/text-data.ts` — rewrite comment `:10-13` accordingly.
- `server/internal/parse-block-data.ts` — normalize BEFORE `.strict().safeParse`, generic on
  the derived flag, and only when a `text` key is PRESENT (never materialize a missing
  `text` — that must stay a loud 400, not an absorbed `[]`):
  ```ts
  const normalized =
    handle.acceptsText && data && typeof data === "object" && "text" in data
      ? { ...(data as object), text: runsOf((data as { text?: unknown }).text) }
      : data;
  ```

**Convert remaining string writers to runs** (client paths bypass the server boundary —
optimistic overlay + in-memory store consume `empty()`/seeds directly):
- 9 `empty()` factories → `text: []`: `text-block.ts:11`, `bulleted-list-block.ts:10`,
  `heading-1/2/3-block.ts:10`, `quote-block.ts:10`, `to-do-block.ts:13`,
  `toggle-block.ts:12`, `callout-block.ts:23`.
- `web/components/block-menu-plugin.tsx:136` and
  `web/components/markdown-shortcut-plugin.tsx:113` — `text: remaining` →
  `text: runsOf(remaining)`.
- Seed sites → `text: []`: `apps/story/shell/create-story.ts:38`,
  `apps/pages/welcome/quick-create/templates.ts:37,45`,
  `apps/pages/page-tree/create-page-with-seed.ts:61`,
  `apps/pages/turn-into-page/turn-block-into-page.ts:32`,
  `apps/pages/inline-page-link/create-linked-page.ts:27`,
  `apps/website/demos/editor-toy/web/seed.ts` (in-memory).
- `math/equation-block.tsx:85` + `divider-block.tsx:54` seed `{text: ""}` into VOID types —
  the same injection bug; drop the `text` key entirely (verify each seeded type first).
- `parseMarkdownToForest` already emits runs from Stage 1; `keyboard-plugin.tsx` convertTo
  already emits runs (`serializeBlockRuns`) — no change.

**Migration** — `./equin build --custom-migration` (DML-only, snapshot-less; style
precedent `20260710_120000_577ba77b__repair_block_data.sql`), slug
`normalize_block_text_runs`:
```sql
-- Collapse legacy string data.text to canonical runs: "" -> [], "hello" -> [{"text":"hello"}].
-- Guarded on jsonb_typeof so it only rewrites string-typed text and is idempotent.
-- Void types never carry `text` (repaired by 20260710_120000_577ba77b), so value-type
-- scoping alone is sufficient and type-agnostic. [[<pageId>]] tokens pass through verbatim.
UPDATE page_blocks
SET data = jsonb_set(data, '{text}',
  CASE WHEN data->>'text' = '' THEN '[]'::jsonb
       ELSE jsonb_build_array(jsonb_build_object('text', data->'text')) END)
WHERE jsonb_typeof(data->'text') = 'string';
```
Do NOT touch `page_block_docs` (Yjs bytes) or `entity_versions` (read through `runsOf`).

**Tests:** `server/internal/parse-block-data.test.ts` — string→runs, `""`→`[]`, runs
pass-through, MISSING `text` on a text-bearing type still 400s, void type with injected
`text` still 400s. Migration itself: covered by the `migration-applies-clean` dry-run +
post-build `query_db` assert (below).

## Stage 3 — paste unification (caret-in-block honors BLOCKS_MIME + splits multi-line)

**Create:**
- `web/internal/clipboard.ts` — move `BLOCKS_MIME` out of `block-editor.tsx:~84` so both
  paste surfaces import one constant.
- `web/components/block-forest-paste-plugin.tsx` — Plugin-only block-text extension
  mirroring `BlockPastePlugin`'s shape (`registerCommand(PASTE_COMMAND, …,
  COMMAND_PRIORITY_NORMAL)`), using `useBlockEditor()` for `paste` and the `Editor.Block`
  contributions for `handles`:
  - a pasted FILE → `return false` (defer to `BlockPastePlugin`, checked via
    `resolvePastedBlock` bail so registration order is irrelevant);
  - `BLOCKS_MIME` present → `preventDefault`, `paste({ blocks: JSON.parse(json), afterId:
    block.id })`;
  - `text/plain` with `\n` → `preventDefault`, `paste({ blocks:
    parseMarkdownToForest(text, handles), afterId: block.id })`;
  - single-line text → `return false` (Lexical default inline paste, untouched).

  Resulting per-block priority stack: files (NORMAL) → forest/multiline (NORMAL) → bare-URL
  (LOW) → Lexical default (LOW).

**Modify:** `block-editor.tsx` imports `BLOCKS_MIME` from `../internal/clipboard`
(`:84,:500,:550`); register the new plugin where `BlockPastePlugin` is wired.

Optional nicety (not required): when the caret block is empty + text-bearing, remove it
after inserting the forest (Notion replaces the empty line); a trailing empty paragraph is
acceptable v1.

---

## Verification (after `./equin build`, scripted à la `e2e/screenshot.mjs`)

1. **Block-selection copy→paste (Stage 1):** page with heading + 2 bullets + a to-do; Esc →
   Shift+Arrow select → Cmd+C → click empty area → Cmd+V. `query_db`:
   `SELECT data->'text' FROM page_blocks WHERE page_id = <id>` — pasted rows carry non-empty
   runs (pre-fix: `[]` / whitespace).
2. **Caret-in-block paste of copied blocks (Stage 3):** Cmd+V with caret inside a block →
   multiple real block rows inserted after it (not one block with whitespace paragraphs).
3. **External markdown paste (Stage 3):** paste `"# H\n- a\n- b\n1. one\n- [ ] task"` →
   heading/bullet/bullet/numbered/to-do rows with correct types + text.
4. **Migration (Stage 2):**
   `SELECT count(*) FROM page_blocks WHERE jsonb_typeof(data->'text') = 'string'` → 0.
5. **Round-trip screenshot:** before/after of a copied-then-pasted rich page.
6. Unit suites: `bun test plugins/page/plugins/editor/core` and
   `bun test plugins/page/plugins/editor/server/internal/parse-block-data.test.ts`.

Playwright: grant clipboard permissions and drive real Cmd+C/Cmd+V (not synthesized
DataTransfer).

## Risks / explicitly out of scope

- **Paste not on the undo stack** — pre-existing gap (paste mints server ids/ranks; clean
  inverse needs the endpoint to return rows). Unchanged; carry forward.
- **read-only-view marker/toggle/ordinal duplication** with `block-text-renderer` —
  pre-existing; untouched.
- **In-memory store parity** — parse emits runs + `empty() → []` on both sides;
  `planForestInsert` stays shared, so memory and server semantics remain byte-identical.
- **Mark-aware markdown fidelity** — future work; `MdSerializeCtx`/`MdParseCtx` are shaped
  so it lands without touching per-type signatures.
- **Schema sync-loadability** — `tables.ts` types `data` as `z.unknown()` and never imports
  block schemas; nothing here reaches the drizzle sync-require graph.
- **Boundary normalization is the compat seam** for pre-migration history snapshots — never
  switch it to reject-on-string.

## Suggested task split

One implementation task per stage (each lands + deploys independently), Opus for all three
(typed API + orchestrator; write-boundary + migration; Lexical paste). Stage 1 alone
resolves the user-reported bug.
