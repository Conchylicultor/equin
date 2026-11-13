import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { declarations } from "./scan";

// The attributes a set of runtime sources declares script-only, as a fold
// kept along the directory tree: a pass after an edit re-reads only the
// edited files. What script-state:no-stylesheet-reads checks every stylesheet
// against.

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** A set of files' declared attributes, and the calls the check cannot read. */
export interface DeclarationsPart {
  attributes: string[];
  /** Report lines: a `defineScriptState` call without a string-literal attribute. */
  unreadable: string[];
}

export const declarationsFold: FileFold<null, DeclarationsPart> = {
  url: import.meta.url,
  scan(src, rel) {
    const part: DeclarationsPart = { attributes: [], unreadable: [] };
    for (const d of declarations(src)) {
      if (d.ok) part.attributes.push(d.attribute);
      else part.unreadable.push(`  ${rel}:${lineOf(src, d.index)} — ${d.text}`);
    }
    return part;
  },
  combine: (parts) => ({
    attributes: parts.flatMap((p) => p.attributes),
    unreadable: parts.flatMap((p) => p.unreadable),
  }),
};
