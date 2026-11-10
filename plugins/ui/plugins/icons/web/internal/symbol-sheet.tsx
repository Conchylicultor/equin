import { useMemo } from "react";
import { splitSheetMarkup } from "./sheet-markup";

/** One `<svg>` of `<symbol>`s in a sheet, and the data attribute naming it. */
export interface SheetEntry {
  readonly key: string;
  /** The whole `<svg>` — server-built from the installed sets, or a family's source-code glyphs; never user markup. */
  readonly markup: string;
  /** The `data-*` attribute its element carries (`data-sprite`, `data-icon-family`, …). */
  readonly attribute: `data-${string}`;
}

/** Rendered but taking no room and painting nothing: what the resources sit in. */
const RENDERED_ZERO_SIZE = {
  position: "absolute",
  width: 0,
  height: 0,
  overflow: "hidden",
  pointerEvents: "none",
} as const;

/** What the symbols sit in: the style engine skips the whole subtree. */
const SKIPPED = { display: "none" } as const;

/**
 * A sheet of `<symbol>`s in the page, so every `<use href="#id">` resolves
 * in-document — inside portals and Fullscreen API subtrees too, which an
 * external `file.svg#id` reference would not reach without a second fetch per
 * document.
 *
 * The symbols sit under `display: none`, so no style recalc ever visits them —
 * they are thousands of elements, more than most apps' visible DOM, and a
 * rendered sheet made every whole-document recalc pay for them. A `<use>`
 * still draws them: it clones the symbol into its own tree. The few resources
 * they reference (`splitSheetMarkup`: an active form's masks) are resolved in
 * the document and not rendered under `display: none`, so they are lifted out
 * into a zero-size rendered subtree, ids unchanged.
 */
export function SymbolSheet({
  entries,
  attribute,
}: {
  entries: readonly SheetEntry[];
  /** The container's own `data-*` attribute (`data-icon-sprites`, …). */
  attribute: `data-${string}`;
}) {
  const split = useMemo(
    () =>
      entries.map((entry) => ({ entry, ...splitSheetMarkup(entry.markup) })),
    [entries],
  );
  return (
    <div aria-hidden style={RENDERED_ZERO_SIZE} {...{ [attribute]: "" }}>
      <div style={SKIPPED}>
        {split.map(({ entry, symbols }) => (
          <div
            key={`${entry.attribute}:${entry.key}`}
            {...{ [entry.attribute]: entry.key }}
            dangerouslySetInnerHTML={{ __html: symbols }}
          />
        ))}
      </div>
      {split.map(({ entry, resources }) =>
        resources === null ? null : (
          <div
            key={`${entry.attribute}:${entry.key}`}
            data-sheet-resources={entry.key}
            dangerouslySetInnerHTML={{ __html: resources }}
          />
        ),
      )}
    </div>
  );
}
