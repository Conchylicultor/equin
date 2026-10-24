# Inline chips in Pages: one token system instead of three

## Context

Today an agent id written in a conversation (`att-1787654245-y41m`, `conv-…`,
`task-…`, `proto-…`) renders as a clickable chip. The same id written in a
**page** renders as raw characters. We want the chips in pages too — pasting
`proto-1787099864-wlwr` into a block should produce a smart chip.

Registering active-data's existing bridge into the page editor is a dozen lines,
and it does not work. Three things stand in the way, and each one is a structural
defect that already costs us elsewhere:

1. **The page editor applies `deserializePattern` only at doc-seed time.** Once a
   block's CRDT doc exists, `@lexical/yjs` rebuilds nodes from the doc's own
   `__type` metadata and never re-scans text. A token typed or inline-pasted into
   an existing block stays literal **forever**. So a live conversion path is part
   of the feature, not polish.

2. **A block holding any decorator node becomes agent-uneditable.**
   `readStateRuns` (`page/plugins/markdown-apply/server/internal/block-doc-text.ts:135`)
   throws on any `Y.XmlElement`, so `edit_page` / `write_agent_note` /
   markdown-apply refuse it. Its own error message asks for "the NODE twin of the
   `Editor.InlineToken` pattern contribution" — which has never been built. This
   already bites `[[page:…]]`, `[[date:…]]` and `\(latex\)`; bare ids would spread
   it across exactly the notes agents write.

3. **There are 3.5 registries for one idea.** active-data's `ActiveData.Tag` slot,
   `text-editor`'s `NodeExtension`, `page/editor`'s `BlockTextExtension` (the
   first two structurally near-identical), plus `read-only-view`'s hardcoded
   two-token scanner — which already has a live bug: `[[date:…]]` renders as
   literal brackets on every read-only surface, because nobody remembered to add
   the third case.

Outcome: chips work in pages on every surface, blocks containing them stay
agent-editable, the date bug is fixed, and adding a future token family means
declaring it once instead of editing four files.

**Out of scope (deliberate):** the `block-…` page-link chip and its overlap with
`[[page:…]]`; the two `display:"code"` chips (`commit-link`, `plugin-link`, whose
claim protocol assumes a host that can decline — a page has none); the `<task>`
block widget (it is conversation-keyed state, so it is a page *block type*, not a
chip).

## Decisions taken

- **Build the server node twin.** The rung-1 fix, and cheap for active-data
  specifically because the token *is* the raw id.
- **Paste-only conversion.** No convert-as-you-type transform (an id is only
  briefly complete while typing — the classic autoformat trap, here on top of a
  CRDT with hand-written caret-offset math), no new typeahead.
- **Backfill declined.** See Migration.

## Design

### One declaration per chip, two readers that cannot drift

Slot contributions are readable **only** through a React hook — `bySlot` is built
inside `PluginProvider`'s `useMemo` (`framework/plugins/web-sdk/core/context.tsx:52-97`).
But the page editor's registry readers are mostly headless
(`use-collab-block-doc.ts:992`, `collab-text-surgery.ts:298`,
`inline-format-surgery.ts:136`, `doc-sourced-runs.ts:63`) and are documented
"read at CALL time, never memoized".

So mirroring `TextEditorSlots.NodeExtensions` into page/editor does **not** work:
a hook is readable from `block-text-editor.tsx` render and from none of those
four — the seed and the projection would see different extension sets, which is
the silent-data-loss case `blockTextRunsOptions`'s docblock
(`block-text-extensions.ts:109-129`) exists to forbid.

Instead:

- **A lazy source on the page registry.** `registerBlockTextExtensionSource(() => BlockTextExtension[])`;
  `getBlockTextExtensions()` folds sources in at call time. Composes exactly with
  the existing contract, so seed and projection are the same set by construction.
- **A module-level registry in active-data, minted by one factory.** Keep
  `ActiveData.Tag` as the only *declaration* surface (it is what puts the chip in
  `docs/plugins-details.md` and the reverse index) and make the inline arm
  **unconstructible except through `inlineChip()`**, which also records into the
  module registry — the same seal-two-halves-together shape as the existing
  `codeTag()` (`active-data/web/slots.ts:82-98`).

```ts
declare const inlineChipBrand: unique symbol;   // not exported
export function inlineChip(spec: {
  id: string;                       // ChipBoundary's label (PluginProvider's _pluginId is a copy, unavailable here)
  pattern: RegExp;
  surfaces: readonly ChipSurface[]; // required — no default
  component: ComponentType<{ content: string; attrs: Record<string, string> }>;
}): ActiveDataInlineContribution;
```

Hand-writing `ActiveData.Tag({ display: "inline", … })` becomes a tsc error.

**`ChipSurface = "transcript" | "document"`, required.** This is how the two
out-of-scope chips stay out of Pages without any consumer naming a contributor —
the chip declares where it belongs, the host asks `inlineChips("document")`.

| chip | surfaces |
|---|---|
| `attempt`, `conv`, `task-link`, `prototype` | `["transcript", "document"]` |
| `page-link` (`block-…`), `improve/element-picker` (`<ui-context>`) | `["transcript"]` |

Three reads, and no way to get a raw `component` out:

```ts
inlineChips(surface): readonly ActiveDataInlineContribution[]
activeDataInlineExtension(surface): BlockTextExtension | null   // the union node extension
renderInlineChip(token): ReactNode | null                      // anchored full-match → <ChipBoundary><Chip/></ChipBoundary>
```

`renderInlineChip` states the anchored full-match rule once (today it is inlined
in `active-data-inline-node.tsx:119-137`) and applies `<ChipBoundary>` inside, so
a consumer physically cannot render a chip unboundaried. Both the Lexical
decorator and the read-only renderer call it; active-data's last two
`UNSAFE_unsealSlotComponent` calls disappear.

### Unify the type, keep two host registries

Two hosts is not the defect — they have genuinely different membership (a page
block must not get `<ui-context>` or attachment-image markdown; a prompt draft
must not get `[[page:…]]`). The defects are that `NodeExtension` and
`BlockTextExtension` are two spellings of one idea, that the (de)serialization
trio is hand-written per contributor so `serializeNode` and `createNodeFromMatch`
can disagree, and that the scan-a-line-for-tokens walk exists three times
(`runs-lexical.ts:110-132`, `text-editor/web/internal/markdown.ts:64-87`,
`runs-renderer.tsx:55-92`).

**New leaf plugin** `plugins/primitives/plugins/text-editor/plugins/token-extension/`
— sited under `text-editor` because `decorator-nav` and `caret-trigger` already
live there and are already imported by `page/editor`. Imports only `lexical` plus
a type-only `react`.

```
core/inline-token-node.ts   defineInlineTokenNode()   ← the node factory
core/token-extension.ts     InlineTokenExtension + tokenExtension()
core/token-scan.ts          matchTokens() / hasToken()  ← the ONE line-scan walk
core/insert-tokens.ts       $insertTokenizedText()
web/components/token-paste-plugin.tsx
```

`defineInlineTokenNode({ type, fields, token, fieldsOf, textContent })` synthesizes
a headless `DecoratorNode` subclass with a zero-arg constructor setting each
`__<field>` (required by `@lexical/yjs`'s `initializeNodeProperties`), generic
`clone`/`importJSON`/`exportJSON`/`isInline`, and `decorate()` returning null. The
**web** class extends it and adds only `decorate()`/`createDOM()` — so the type
string, field names and token format are declared once in `core/` and both
runtimes share the class hierarchy.

> **The stub hazard becomes inexpressible.** `block-doc-text.ts:105-116` warns
> that a stub class lacking `getTextContent` would make hydration *succeed* while
> silently deleting the token. There is no way to obtain a node class for this
> system except through `defineInlineTokenNode`, which requires `token`; every
> extension's `serializeNode` derives from that same `token`; and `tokenOf()`
> tries `serializeNode` before `getTextContent()`. A class that serializes to `""`
> cannot be written.

Note `textContent: "token" | "empty"` is an explicit declared decision, not an
accident: `PageLinkInlineNode.getTextContent()` is deliberately empty (so the
token never leaks into the slash-menu / `[[`-query root-text scans) while
`ActiveDataInlineNode`'s deliberately returns the token (for the clipboard
payload, pinned by `active-data-inline-copy.test.tsx`). Caret math is unaffected
either way — `nodePlainLength` and `$xmlBasisContentLength` both go through
`tokenOf`, never raw `getTextContent()`.

`TextEditorSlots.NodeExtensions` and `node-extension-bridge.ts` are **deleted**:
once active-data has a module registry its only contributor is gone. Registry
count 3.5 → 2 hosts over 1 shared type.

### Code-marked runs must not chip

`lineNodes` never inspects `run.marks`, and `read-only-view`'s `segmentsOf` runs
on every run including `code`-marked ones. So `` `att-1755000000-ab12` `` written
as inline code — the natural way to document an id — silently becomes a live
widget and loses its code styling. This has never bitten before because the
prompt editor is `PlainTextPlugin` with no marks concept at all; the page editor
is the first surface with both.

**`matchTokens` takes the run's marks and returns no matches for a `code` run.**
One place, so it fixes the editor seed, the read-only renderer and all four token
families at once. (Fenced code *blocks* are already safe — `code-block` stores a
plain string outside the runs pipeline.)

### The server node twin

`Editor.InlineToken` (`page/editor/server/internal/block-registry.ts:29-34`) gains
a second optional field — the **node spec object from `core/`**, never a class:

```ts
defineServerContribution<{ pattern?: RegExp; node?: InlineTokenNode<never> }>("page.inline-token", …)
// plugins/page/plugins/inline-page-link/server/index.ts
Editor.InlineToken({ pattern: PAGE_LINK_TOKEN_PATTERN, node: pageLinkInlineNode })
```

Because it is the same object the web class extends, the two runtimes cannot name
different types, fields or token formats — the argument the existing pattern-only
docblock already makes, extended to the node half. `node` stays optional (a pure
text token with no decorator is legitimate); absent ⇒ that type keeps throwing.

New in `page/editor/server`, both read at call time like `blockTextProtectedSpans()`:
`blockTextServerExtensions()` and `blockTextServerNodes()`. Two contributions may
share a node `type` only if they name the same spec object (identity) — which is
what lets active-data's four sub-plugins each contribute a pattern against one
shared node.

Then in `block-doc-text.ts`: `opaqueNodeTypes` is unchanged, but `readStateRuns`
**subtracts the types that have a registered server node**, and any remainder
still throws. The refusal narrows; it does not soften. `xmlTextToRuns` and
`editYDocState` gain the server extensions/nodes; `buildSeedState` gains a real
fingerprint.

**And `runs-splice.ts`, without which the feature does not work.** It keys a
decorator's alignment unit as `` `opaque␀${node.getKey()}` `` (lines 150-161) —
deliberately unmatchable. So once hydration succeeds, every chip in an
agent-edited block falls into the rebuilt middle and is rebuilt with
`$appendRuns(…, [])`: the token survives as characters, but the **node is
destroyed**, and since nothing re-scans an existing doc the chip is gone forever.
Fix: key a registered token as `` `token␀${tokenOf(node, exts)}` `` so an unchanged
chip aligns into the common prefix/suffix and keeps its CRDT item, mirror the
token split in `newUnitsOf`, and pass extensions to `$appendRuns` so a *changed*
middle re-materializes. The unregistered arm stays as-is (unreachable —
`readStateRuns` refuses first).

Free consequence: any `edit_page` that rebuilds a block's middle now materializes
the chips in it. That is the migration path.

### Paste

`TokenPastePlugin` is the lifted `ExtensionPastePlugin` with one added gate: it
**declines when the clipboard carries `application/x-lexical-editor`**, because
that payload already holds the materialized decorator and Lexical's own path
reconstructs it perfectly. Without this, an intra-app copy of `**bold** att-…`
would be re-parsed from `text/plain` and lose its marks — a latent bug in the
prompt editor's copy too, fixed here for both.

Mounted in `block-text-editor.tsx` **after** the contributed `ext.Plugin`s, at
`COMMAND_PRIORITY_LOW`:

| # | handler | priority | claims |
|---|---|---|---|
| 1 | `BlockPastePlugin` | NORMAL | a pasted file (an upload, never text) |
| 2 | `BlockForestPastePlugin` | NORMAL | forest MIME, or any multi-line text |
| 3 | `UrlPastePlugin` | LOW (registered first) | a bare URL into an empty block |
| 4 | **`TokenPastePlugin`** | LOW | single-line text with a token, no `x-lexical-editor` |
| 5 | Lexical RichText default | EDITOR | everything else |

Below NORMAL because a file paste is an upload and a multi-line paste is
structural — which also means this only ever sees single-line text, so a plain
inline insert suffices. Not above `UrlPastePlugin`, because "URL into an empty
block → bookmark" is shipped; within LOW, order is JSX order. Belt and braces:
the gates are provably disjoint (`inlineBoundary`'s `(?<!\/)` means an id inside
a URL path never matches).

**No surgery helper, deliberately.** `collab-text-surgery.ts` exists for edits
driven from outside a Lexical command; a `PASTE_COMMAND` listener already runs
inside `editor.update()`, and `selection.insertNodes` syncs like typing and lands
on the block's `Y.UndoManager` for free. Neither `no-adhoc-structural-write` (the
`page_blocks` endpoints) nor `no-adhoc-forest-write` (the `_blocks` table) applies.

Already free: a *multi-line* paste containing an id goes through
`BlockForestPastePlugin` → new blocks → seeded with extensions → chips. Only the
single-line inline paste needed new code.

### Read-only renderer

`BlockTextExtension` gains `renderToken?: (fields) => ReactNode`, **required
whenever `node` is present** (a discriminated pair, so tsc rejects a node without
a renderer). That is what makes the inline-date bug a compile error rather than an
omission: every family must render itself outside Lexical, so `RunsRenderer`
becomes total and has no reason to special-case a type again.

`runs-renderer.tsx` loses the two token-pattern imports (lines 9-10), the closed
`Segment` union (41-47) and the two-regex race (55-92); `segmentsOf` becomes
`matchTokens(text, run.marks, getBlockTextExtensions())` — the same walk
`lineNodes` uses. `decorateRun` is untouched. `PageLinkChip` moves into
`inline-page-link/web`; `read-only-view` stops owning it. active-data supplies
`(f) => renderInlineChip(f.text)`.

## Migration

| situation | what happens |
|---|---|
| raw id in an **already-seeded** block doc | editor: stays plain text (the accepted cost of paste-only) |
| the same block on a **read-only** surface | renders as a chip immediately, from `data.text` |
| the same block after any `edit_page` rewriting its middle | becomes a real node — self-healing, no sweep |
| a **new** block from paste, markdown-apply or an agent | chip from the first seed |
| existing `[[page:…]]` / `[[date:…]]` / math docs | unchanged; read-only rendering improves (date fixed) |

**Backfill declined** — it means a server sweep rewriting live CRDT state on every
`page_block_docs` row, fighting mounted editors, for a value whose fallback is
already lossless and already chips on read surfaces. The natural paths converge.
Record in `page/editor/CLAUDE.md`.

Accepted asymmetry: for a legacy block, the editor and the read-only view disagree
about whether an id is a chip. The read surface is where the chip earns its keep;
the alternative is a backfill or degrading the read surface to match.

## Stages

Each builds, deploys and leaves the app working. **Stages 2 and 3 must ship
together** — Stage 2 alone makes `edit_page` refuse chip-bearing blocks.

- **0 — the shared token primitive** (pure refactor, no behaviour change). Create
  `token-extension/`. Migrate `inline-page-link`, `inline-date`, `math/inline`,
  `text-editor/paste-images` onto `defineInlineTokenNode` + `tokenExtension`; make
  the branded `node` required. Add the `x-lexical-editor` decline and the
  `code`-mark skip. *The existing `collab-roundtrip.test.ts` files are the
  regression net — they must pass unchanged.*
- **1 — active-data's one-registry factory.** `inlineChip()` + brand + module
  registry + `surfaces` + `renderInlineChip()`. Migrate all 8 inline chips; move
  the 4 in-scope `web/internal/pattern.ts` to `core/`. Delete
  `TextEditorSlots.NodeExtensions`, `node-extension-bridge.ts` and
  `useMergedNodeExtensions`'s dynamic arm. User-visible behaviour unchanged.
- **2 — the page bridge.** `registerBlockTextExtensionSource`; active-data
  registers `() => [activeDataInlineExtension("document")]`.
- **3 — the server node twin.** `Editor.InlineToken` gains `node`; add
  `blockTextServerExtensions/Nodes()`; rework `block-doc-text.ts` and
  `runs-splice.ts`. Add 4 server barrels under `active-data/plugins/*/server/`
  (~8 lines each). Rewrite `markdown-apply/CLAUDE.md`'s "Known gap".
- **4 — paste.** Mount `TokenPastePlugin` with the ordering comment.
- **5 — read-only renderer.** Registry-driven; `renderToken` on all four families;
  move `PageLinkChip`.
- **6 — hardening.** Pattern tests for `att`/`conv`/`task-link` — none exist today,
  though `prototype`, `page-link` and `commit-link` all have one. The suspected
  backtracking hole in `task-\d+-[a-z0-9]{4,8}`'s *variable* suffix was **checked
  and is not real**: `inlineBoundary`'s trailing `\b` blocks it, because any
  truncation of the suffix lands between two word characters, so
  `task-1755000000-ab12cdef/subpath` matches nothing at all. Pin that case anyway,
  along with `att-…/logs`, `att-…e` (over-long suffix) and
  `https://x.dev/att-…`, all of which correctly match nothing today. Scoped check
  `page.editor:no-token-pattern-outside-owner` (follow
  `plugins/active-data/check/index.ts`). Check that a chip declaring `"document"`
  has a server half, so it fails at check time rather than at the agent's first
  `edit_page`.

## Critical files

- `plugins/page/plugins/editor/web/internal/block-text-extensions.ts` — the lazy source
- `plugins/page/plugins/editor/core/runs-lexical.ts` — the shared scan + `code`-mark skip
- `plugins/active-data/web/slots.ts` — the branded factory
- `plugins/page/plugins/markdown-apply/server/internal/block-doc-text.ts` — the narrowed refusal
- `plugins/page/plugins/markdown-apply/server/internal/runs-splice.ts` — token-keyed alignment
- `plugins/page/plugins/read-only-view/web/components/runs-renderer.tsx` — registry-driven
- `plugins/primitives/plugins/text-editor/web/{slots.ts,internal/node-extensions.ts,internal/markdown.ts}`

## Verification

`./equin test <path>` is the only runner. `*.test.ts` beside source =
bun:test; `web/__tests__/` = jsdom.

| path | pins |
|---|---|
| `token-extension/core/inline-token-node.test.ts` | zero-arg construction sets every `__field`; `clone` preserves fields + key; `token`/`fieldsOf` round-trip |
| `token-extension/core/token-scan.test.ts` | sort + overlap-drop + `hasToken` + **the `code`-mark skip**, over `page/editor/core/runs-corpus.ts` |
| `active-data/web/internal/inline-registry.test.tsx` | `inlineChip` records once; duplicate id throws; `inlineChips("document")` excludes a transcript-only chip |
| `active-data/web/internal/page-collab-roundtrip.test.ts` | **copy `inline-page-link/web/internal/collab-roundtrip.test.ts` verbatim** with a real `att-…`: same `decoratorFields` helper, same two assertions, plus marks-either-side and **a token inside a `LinkNode`** |
| `markdown-apply/server/internal/block-doc-text.test.ts` | a doc holding `active-data-inline` reads back its token; a splice around it **preserves the node key**; a splice through it **re-materializes**; an *unregistered* type still throws, naming it |
| `read-only-view/web/__tests__/runs-renderer.test.tsx` | **`[[date:…]]` renders a chip, not literal brackets**; an unregistered token stays text; a `code`-marked id stays text |
| existing `collab-roundtrip` ×3, `active-data-inline-copy.test.tsx` | must stay green |

By hand at `http://att-1787654245-y41m.localhost:9000/pages` after
`./equin build` (`run_in_background: true`):

1. Paste an attempt id inline → chip; click → attempt pane opens (cross-app push).
2. Reload → chip persists (proves it is a node, not a re-scan).
3. Arrow across it, Backspace it, hover for the ×.
4. Paste a bare URL into an empty block → bookmark menu still appears (LOW ordering).
5. Paste multi-line markdown with a `task-…` id → several blocks, each chipped.
6. `edit_page` the chip-bearing block, changing one word → succeeds, chip survives.
7. Page history / diff → chip renders read-only; a `@`-inserted date chip renders
   there too instead of `[[date:…]]`.
8. Conversation transcript unchanged; `block-…` still chips **there** and not in a page.
9. Type an id into a page block → stays plain text (declared paste-only behaviour).
10. Write `` `att-…` `` as inline code → stays code, no chip.

`./equin check` expected to fire: `plugins-registry-in-sync` and
`plugins-doc-in-sync` (new plugin + 4 server barrels; plus hand-written prose in
`active-data`, `page/editor`, `markdown-apply`, `read-only-view`, `text-editor`
CLAUDE.mds), `plugin-boundaries` (new `active-data → page/editor` edges — verified
acyclic: nothing under `plugins/page/` imports `@plugins/active-data`, and
`detectCycle` at `boundaries/core/check.ts:200` runs over the discovered import
graph, so it would catch a regression), `type-check` (the branded contribution and
required `renderToken` are deliberate errors at unmigrated call sites). **Not**
expected: `migrations-in-sync` (no schema change).

## Known risk, not solved by this plan

`@lexical/yjs` **throws** `Node <type> is not registered` (`LexicalYjs.dev.mjs:942`)
when it meets a `Y.XmlElement` whose type the local editor lacks. So a composition
that ships Pages *without* a token plugin, opening a document containing that
plugin's nodes, hard-fails. This is already true of `inline-page-link` / `inline-date`
/ `math`; active-data is merely more droppable, being a separate top-level plugin.

Two partial mitigations, both cheap: `activeDataInlineExtension("document")`
returns the extension **with its node** even when zero chips declare `"document"`,
so the class is registered and hydration survives (the chip then degrades to plain
text — `decorate()` already does `if (!match) return <>{text}</>`); and the
composition closure should treat a page token plugin as required once any document
holds its nodes. Worth a follow-up task rather than blocking this work.
