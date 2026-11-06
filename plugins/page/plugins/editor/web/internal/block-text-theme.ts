/**
 * The Lexical theme every page text surface shares — a block's own text and a
 * `RichTextField` over a `RichText` in `data` — so a mark reads the same in a
 * paragraph and in a table cell.
 *
 * Inline mark classes, applied by Lexical to formatted TextNodes. These are
 * plain class strings passed to the framework (not JSX className), so they map
 * marks → utilities directly.
 */
export const BLOCK_TEXT_THEME = {
  text: {
    bold: "font-bold",
    italic: "italic",
    underline: "underline",
    strikethrough: "line-through",
    code: "rounded-md bg-muted px-xs font-mono text-[0.9em]",
  },
  link: "text-primary-text underline",
} as const;
