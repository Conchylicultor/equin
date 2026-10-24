# Inline rich-text formatting for page blocks

**Status:** design → implementation
**Author:** agent (autonomous)
**Date:** 2026-06-15

## Problem

The Pages block editor (`plugins/page/plugins/editor`) mounts Lexical's
`PlainTextPlugin` per text block, so block text cannot be **bold / italic /
underline / strikethrough / inline-code / colored / linked**, and there is no
selection format toolbar. Inline rich text is core to a Notion-like product and
is the single largest content gap.

Block text is stored as a **plain string** in `data.text` (jsonb `{ text: string }`).
The string is the source of truth, round-tripped to/from the Lexical tree on
every keystroke (`ValueSyncPlugin` + `serializeBlockText`). Inline page links are
embedded in that string as `[[<pageId>]]` tokens and parsed back into decorator
nodes by the `BlockTextExtension` registry.

## Goals

- Bold, italic, underline, strikethrough, inline-code marks on any text span.
- Text color (closed theme-token palette, no ad-hoc hex).
- Inline links (`href`).
- A floating selection toolbar + keyboard shortcuts (Cmd+B/I/U, Cmd+E code, Cmd+K link).
- A **persisted serialization format** that survives split / merge / paste / backlinks.
- Zero data migration; existing plain-string content keeps working forever.

## Non-goals (this pass)

- Markdown *paste* producing marks (the markdown importer keeps emitting plain
  strings, which are valid legacy values). Future enhancement.
- Block-level color/background, highlight background. Text color only.

## Decision: structured inline **runs** (Notion-style), stored in `data.text`

`data.text` changes from `string` to `string | RichText`, where:

```ts
type Mark = "bold" | "italic" | "underline" | "strikethrough" | "code";
type ColorToken = "default" | "gray" | "brown" | "orange" | "yellow"
                | "green" | "blue" | "purple" | "pink" | "red";

interface TextRun {
  text: string;            // may contain "\n" soft breaks and [[pageId]] tokens
  marks?: Mark[];          // omitted when none
  color?: ColorToken;      // omitted / "default"
  link?: string;           // href, omitted when none
}
type RichText = TextRun[];
```

- **Legacy string** = a single unmarked run. A normalizer `runsOf(data)` coerces
  `string | RichText → RichText`; `plainOf(data)` flattens `→ string`. New writes
  always persist arrays. **No DB migration** — the union + normalizer is the back-compat
  seam, and it is the single source of truth (3-line helpers).
- **Page-link tokens stay inside run text.** `plainOf` still yields the
  `[[pageId]]` tokens, so the backlinks extractor and the `BlockTextExtension`
  token mechanism are unchanged. Marks are a *parallel*, additive concern layered
  on top of the existing token model — this keeps blast radius off the
  `inline-page-link` / `links` plugins (one line in the extractor: parse `plainOf`).

### Why runs, not markdown tokens (`**bold**`)

- Color and underline have **no** markdown representation.
- Overlapping / ambiguous marks (literal `*`) are a parsing minefield.
- Runs are the proven Notion model the product explicitly emulates and are
  framework-agnostic (not tied to Lexical's internal JSON).

### Why a union (not a migration)

A jsonb data-transform migration over every existing block is riskier and gives
nothing the normalizer doesn't. The union is permanent, cheap, and total.

### Serialization vocabulary is closed (Lexical), toolbar is open (sub-plugins)

The runs↔Lexical converter knows the **closed** set of Lexical inline features:
the 5 format flags (`hasFormat("bold")` …), `style` color, and `LinkNode`. That
is Lexical's own inline vocabulary — acceptable coupling to the editor framework,
not an extensibility surface. The **toolbar buttons**, by contrast, are
sub-plugins contributing to a slot, so the UI is extensible without touching
serialization.

## The shared `text` field is duplicated — fix it

`text: z.string()` is independently declared in **four** places:
`textDataSchema` (text + bulleted-list), `to-do` (`{text, checked}`), and
`toggle` (`{text}`). The rich-text field type must be shared, so export
`RichTextSchema = z.union([z.string(), z.array(TextRunSchema)])` from editor core
and have all four compose it. This both fixes the duplication and guarantees
every text-bearing block type gains marks uniformly.

## Touch points (audited)

| File | Change |
|---|---|
| `editor/core/rich-text.ts` *(new)* | `Mark`, `ColorToken`, `TextRun`, `RichText`, `RichTextSchema`, `runsOf`, `plainOf`, `splitRuns(runs, offset)`, `mergeRuns(a, b)`, `runsLength`. + unit tests. |
| `editor/core/text-data.ts` | `textDataSchema.text` → `RichTextSchema`. |
| `editor/core/block-ops.ts` | `textOf`→`runsOf`, `withText`→`withRuns`; `split`/`merge` operate on runs (`splitRuns`/`mergeRuns`); op `text?: string` → `runs?: RichText`. Update `block-ops.test.ts`. |
| `to-do/core`, `toggle/core` | `text` field → `RichTextSchema`. |
| `editor/web/internal/block-text-extensions.ts` | Replace line-based `appendLineNodes`/`serializeBlockText` with **runs↔Lexical** conversion: text run → TextNode(s) with format flags (marks) + `style` (color), wrapped in `LinkNode` when `link` set; `\n` → LineBreakNode; extension tokens inside run text still parsed to decorator nodes (token text → unmarked run on the way back). |
| `editor/web/components/block-text-editor.tsx` | `PlainTextPlugin` → `RichTextPlugin`; `theme.text` classes for marks; register `LinkNode`. |
| `editor/web/components/value-sync-plugin.tsx` | sync `RichText` (not string); compare by stable JSON. |
| `editor/web/components/keyboard-plugin.tsx` | split/merge pass `runs` (serialize live tree → runs). |
| `editor/web/block-editor-context.tsx` | `split`/`merge` op `text` → `runs`. |
| `inline-page-link/server/internal/extract-inline-links.ts` | scan `plainOf(data)` instead of `data.text as string`. |

Read-only rendering: none — every text block always mounts an editable Lexical
instance, so marks render via the editor `theme.text` classes (no separate
renderer to update).

## Selection toolbar + marks (sub-plugins)

New umbrella `plugins/page/plugins/formatting/`:

- **Host** (in `editor`): a `FormatToolbar` Lexical plugin mounted inside each
  block composer that tracks the live selection and portals a floating toolbar
  above a non-collapsed selection (via `viewport-overlay` + selection rect). It
  renders a new render-slot `Editor.FormatAction`.
- Sub-plugins contributing buttons: `bold`, `italic`, `underline`,
  `strikethrough`, `code` (Phase 2); `link`, `color` (Phase 3). Each dispatches
  the relevant Lexical command and reflects active state from the selection.
- Shortcuts: `RichTextPlugin` wires Cmd+B/I/U for free. Add Cmd+E (code),
  Cmd+Shift+X (strikethrough), Cmd+K (link) via Lexical commands.

Marks render through `theme.text`: `bold→font-bold`, `italic→italic`,
`underline→underline`, `strikethrough→line-through`, `code→<inline code chrome>`.
Color renders via inline `style="color: var(--rt-color-…)"` mapped to theme
tokens (a small palette block in `app.css`/tokens, respecting light/dark).

## Phasing

1. **Core model + editor plumbing** — runs model, block-ops on runs,
   runs↔Lexical converter, RichTextPlugin swap, schema sharing, consumer fixes.
   Marks *render* and *persist* (formats applied programmatically already round-trip),
   but no toolbar yet. Build + tests green.
2. **Selection toolbar + boolean marks** — toolbar host + bold/italic/underline/
   strikethrough/code sub-plugins + shortcuts.
3. **Link + color** — `LinkNode` integration + link popover; color palette + picker.

Each phase ends with `./equin build` + targeted tests + a Playwright check.

## Risks / subtleties

- **Split offset vs decorator width.** Split position is a caret offset; runs
  flatten must count atomic decorator nodes (page-links) consistently with
  Lexical's selection width. `splitRuns` treats the page-link token text as part
  of the plain offset (same basis as `serializeBlockText` today), so caret offset
  ↔ runs offset stay aligned. Covered by `block-ops` + converter tests.
- **Self-write echo.** `ValueSyncPlugin` already guards self-writes; the runs
  comparison must be stable (canonical JSON) to avoid feedback loops.
- **Mark coalescing.** `mergeRuns` should coalesce adjacent runs with identical
  marks/color/link to keep payloads small and diffs stable.
</content>
</invoke>
