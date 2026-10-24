# Numbered / ordered list block for the Pages editor

**Date:** 2026-06-15
**Status:** Design → implementation

## Problem

The Pages block editor has `text`, `bulleted-list`, `to-do`, `toggle`, etc., but
no **numbered/ordered list** block. We want one with automatic sequential
numbering that:

- numbers consecutive sibling items `1. 2. 3. …`,
- **resets per nesting level** (each parent's children are numbered
  independently),
- **restarts after an interruption** by a non-numbered block (standard `<ol>` /
  markdown behavior — a run of consecutive `numbered-list` siblings is one
  sequence),
- re-numbers automatically on insert / delete / reorder / indent / outdent,
- supports the `1. ` markdown live-shortcut, markdown paste (`1.`/`1)`/`2.`…),
  and markdown copy-out.

## Key constraint: in-place conversion

Every editable-text block type registers the **same** `BlockTextRenderer`
component against the `Editor.Block` dispatch slot. That is deliberate: the
dispatch key is `block.type`, so when a block converts type (e.g. `* ` → bullet)
React reconciles the *same* component instance — the live Lexical editor, its
focus and caret all survive. A numbered list **must** therefore also render
through `BlockTextRenderer` (a bespoke component would remount on every
conversion and drop the caret).

Consequence: the sequential number must flow **through** `BlockTextRenderer`,
not be computed inside a private component.

## Design

Numbering is an editor-**structural** property (position among siblings), not
per-block data. So nothing is stored — the number is derived at render time from
the already-sorted sibling order, exactly like depth is.

### 1. New capability on `BlockHandle`: `ordinalMarker`

`define-block.ts` already models presentation generically: `marker` (static
glyph) and `toggle` (checkbox). Add a third, parallel, **generic** capability —
the editor core still never names a block type:

```ts
/**
 * For editable-text list blocks whose marker is its 1-based position among the
 * consecutive run of same-type siblings (an ordered list). The shared renderer
 * draws `ordinalMarker(n)` as the leading glyph; markdown paste routes N./N)
 * lines to this type and copy emits real sequential numbers. Generic — the
 * editor core never names a specific block type.
 */
ordinalMarker?: (ordinal: number) => string;
```

This keeps `marker` as the static case and `ordinalMarker` as the
position-derived case — orthogonal and self-describing.

### 2. Compute the ordinal in `flattenTree` (block-editor.tsx)

`flattenTree` already walks each sibling list in rank order. For every node,
compute its 1-based index within the **maximal run of consecutive same-`type`
siblings** (reset on type change or new parent). Carry it on `FlatBlock`:

```ts
type FlatBlock = { block: Block; depth: number; hasChildren: boolean; ordinal: number };
```

This is a pure structural property (no handle knowledge needed); only
`ordinalMarker` handles consume it, everyone else ignores it.

### 3. Thread `ordinal` to the renderer

- `BlockRendererProps` gains `ordinal: number` (`web/types.ts`).
- `BlockRow` accepts `ordinal` and passes it to `Editor.Block.Dispatch`.
- `BlockEditor` passes `f.ordinal` into `BlockRow`.

### 4. Render the marker (`BlockTextRenderer`)

Add a branch *before* the static `marker` branch:

```ts
} else if (handle?.ordinalMarker) {
  marker = (
    <Text as="span" variant="body" aria-hidden
      className="text-muted-foreground flex-none select-none tabular-nums py-xs pl-md pr-xs">
      {handle.ordinalMarker(ordinal)}
    </Text>
  );
}
```

`tabular-nums` keeps digit widths even. (No `min-width`: arbitrary spacing trips
`no-adhoc-spacing`; ragged start only appears past item 10 and is acceptable —
can be polished later with a token-sized gutter.)

### 5. The block plugin: `plugins/page/plugins/numbered-list/`

Mirrors `bulleted-list` byte-for-byte:

- `core/numbered-list-block.ts`:
  ```ts
  export const numberedListBlock = defineBlock({
    type: "numbered-list",
    schema: textDataSchema,
    label: "Numbered list",
    icon: MdFormatListNumbered,
    aliases: ["number", "ordered", "ol", "1."],
    empty: () => ({ text: "" }),
    placeholder: "List",
    ordinalMarker: (n) => `${n}.`,
    markdownPrefixes: ["1. "],   // drives ONLY the live `1. ` shortcut
  });
  ```
- `core/index.ts`, `web/index.ts` (contributes `Editor.Block` with
  `BlockTextRenderer`), `package.json` — all copied from bulleted-list.

`markdownPrefixes: ["1. "]` exists solely so the generic
`MarkdownShortcutPlugin` converts a freshly-typed `1. ` with zero changes there.
Paste/copy are handled by the dedicated ordinal passes below (and the ordinal
handle is excluded from the generic paste prefix rules).

### 6. Markdown interop (`markdown-blocks.ts`)

- **`orderedHandle(handles)`** = `handles.find(h => h.ordinalMarker)` (parallels
  `toggleHandle`/`fenceHandle`).
- **Paste in** (`markdownToForest`): add an `ORDERED = /^\d+[.)]\s+(.*)$/` pass
  **before** the generic prefix rules, routing to the ordered handle (matches
  `1.`, `2)`, `10.`, … — numbering is positional, the literal number is
  discarded).
- **`prefixRules`**: skip prefixes from the ordinal handle (the `1. ` prefix is
  for the live shortcut only; the ORDERED pass already covers paste), so it isn't
  a dead/duplicate rule.
- **`defaultTextHandle`**: also exclude `h.ordinalMarker` (so numbered-list is
  never chosen as the plain-paragraph fallback).
- **Copy out** (`blocksToMarkdown`): thread a per-run ordinal through `walk`
  (same consecutive-same-type counter as flattenTree) and, in `lineFor`, when
  `h.ordinalMarker` emit `` `${h.ordinalMarker(n)} ${text}` `` → real
  `1. / 2. / 3.` lines.

## Files

**New** (`plugins/page/plugins/numbered-list/`): `package.json`,
`core/index.ts`, `core/numbered-list-block.ts`, `web/index.ts`.

**Modified** (all inside the `page/editor` plugin — its own extension API, not a
cross-cutting primitive):
- `core/define-block.ts` — add `ordinalMarker` to interface + `defineBlock`.
- `web/types.ts` — add `ordinal` to `BlockRendererProps`.
- `web/components/block-text-renderer.tsx` — render ordinal marker.
- `web/components/block-editor.tsx` — compute ordinal in `flattenTree`, pass down.
- `web/components/block-row.tsx` — accept/forward `ordinal`.
- `web/markdown-blocks.ts` — ordered paste/copy + exclusions.

**No changes** to keyboard/intent, block-ops, schema/tables, or the
markdown-shortcut plugin (all already generic). Registration is filesystem-driven
— `./equin build` regenerates the registry; no manual list edit.

## Numbering semantics (decision)

A numbered run = **consecutive** same-type siblings. Interrupt with any other
block ⇒ the next numbered block restarts at 1. This matches HTML `<ol>`/markdown
grouping and is the least-surprising default. (Notion's "continue previous
numbering across an interruption" is intentionally *not* replicated — it needs
extra per-block state and is the rarer case.)
