import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { unscopedHighlights } from "./scan";

// unscoped-highlight-pseudo's per-file work as a fold kept along the directory
// tree (`defineFoldCheck`): each file judged on its own bytes, so a pass after
// an edit reads only the edited files. Its records are keyed by this module's
// closure (./scan included), so an edit to the matcher re-folds every file.

function stripCssComments(src: string): string {
  // Keep the newlines, so line numbers still point at the source.
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** Each offending `::highlight()` rule of a set of files, as a report line, in path order. */
export type UnscopedHighlightPart = string[];

export const unscopedHighlightFold: FileFold<null, UnscopedHighlightPart> = {
  url: import.meta.url,
  scan(raw, rel) {
    if (!raw.includes("::highlight(")) return [];
    const src = stripCssComments(raw);
    return unscopedHighlights(src).map(
      (h) => `  ${rel}:${lineOf(src, h.index)} — ${h.text}`,
    );
  },
  combine: (parts) => parts.flat(),
};
