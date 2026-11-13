import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { arbitraryVariants, complexNegations } from "./scan";

// negated-complex-selector's per-file work as a fold kept along the directory
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

/** Whether the line holding `index` is a comment line (`//`, `/*`, ` * `). */
function onCommentLine(src: string, index: number): boolean {
  const start = src.lastIndexOf("\n", index) + 1;
  return /^\s*(\/\/|\/\*|\*)/.test(src.slice(start, index));
}

/** Each offending `:not()` of a set of files, as a report line, in path order. */
export type NegationPart = string[];

export const negatedComplexSelectorFold: FileFold<null, NegationPart> = {
  url: import.meta.url,
  scan(raw, rel) {
    if (!raw.includes(":not(")) return [];
    const css = rel.endsWith(".css");
    const src = css ? stripCssComments(raw) : raw;
    // Tailwind variants: class strings, and `@apply` in CSS.
    const variants = arbitraryVariants(src)
      .filter((v) => css || !onCommentLine(src, v.index))
      .flatMap((v) =>
        complexNegations(v.text, { underscoreIsSpace: true }).map((n) => ({
          index: v.index + n.index,
          text: n.text,
        })),
      );
    const hits = css
      ? [...complexNegations(src, { underscoreIsSpace: false }), ...variants]
      : variants;
    return hits.map((n) => `  ${rel}:${lineOf(src, n.index)} — ${n.text}`);
  },
  combine: (parts) => parts.flat(),
};
