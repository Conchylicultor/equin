import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { stripCssComments, stylesheetReads } from "./scan";

// Every stylesheet read of a declared script-only attribute, per file, as a
// fold kept along the directory tree: a pass after an edit re-reads only the
// edited files. The declared attributes are the fold's context, so declaring
// a new one re-folds every file — the only edit that can change another
// file's answer.

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/**
 * What every file's part reads: the declared attributes (sorted, distinct),
 * and the declarations the check could not read (the verdict reports them;
 * no file's part depends on them).
 */
export interface StylesheetReadsContext {
  [key: string]: readonly string[];
  attributes: readonly string[];
  unreadable: readonly string[];
}

/** Report lines, in path order: each stylesheet selector naming a declared attribute. */
export type StylesheetReadsPart = string[];

export const stylesheetReadsFold: FileFold<
  StylesheetReadsContext,
  StylesheetReadsPart
> = {
  url: import.meta.url,
  scan(raw, rel, { attributes }) {
    const css = rel.endsWith(".css");
    const src = css ? stripCssComments(raw) : raw;
    const out: string[] = [];
    for (const attribute of attributes) {
      if (!src.includes(attribute.slice("data-".length))) continue;
      for (const h of stylesheetReads(src, attribute, { css }))
        out.push(
          `  ${rel}:${lineOf(src, h.index)} — ${h.text} (reads ${attribute})`,
        );
    }
    return out;
  },
  combine: (parts) => parts.flat(),
};
