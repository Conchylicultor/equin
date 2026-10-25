import type { CSSProperties } from "react";

/**
 * Where a depth-`depth` row's content starts, from the full-width row's own
 * edge: `depth` indent steps after the row's lead inset (density
 * `treeIndent` / `treeRowPadStart`). The default step is one chevron box plus
 * the row's cell gap (`--tree-chevron-w` + `--tree-row-gap`), so a row's
 * content starts where its parent's second cell (the icon, after the chevron
 * box) does. Every box that mirrors a tree row's
 * geometry (the placeholder row, the aligned-columns header) reads it here, so
 * none re-spells the formula.
 */
export function treeContentIndent(depth: number): string {
  return `calc(${depth} * var(--tree-indent) + var(--tree-row-pad-start))`;
}

/**
 * A tree row's indent, split between its pill and its content: each level
 * moves the pill by `--tree-pill-indent` (margin, so the hover / selected fill
 * starts there) and its content by the rest of the step (padding). The content
 * lands at {@link treeContentIndent} whatever the split.
 */
export function treeRowIndentStyle(depth: number): CSSProperties {
  return {
    marginLeft: `calc(${depth} * var(--tree-pill-indent))`,
    paddingLeft: `calc(${depth} * (var(--tree-indent) - var(--tree-pill-indent)) + var(--tree-row-pad-start))`,
  };
}
