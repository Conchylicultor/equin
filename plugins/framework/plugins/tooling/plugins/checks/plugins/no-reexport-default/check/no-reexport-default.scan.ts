import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { maskSource } from "@plugins/plugin-meta/plugins/parse-utils/core";

// no-reexport-default's per-file work as a fold kept along the directory
// tree: a barrel's default-export shape is a function of its bytes alone, so
// a pass after an edit reads only the edited barrels — never the ~2k a
// whole-tree read made on every pass.

const INLINE_DEFAULT_RE = /(^|\n)\s*export\s+default\s+\{/;
const REEXPORT_DEFAULT_RE =
  /(^|\n)\s*export\s*\{[^}]*\bdefault\b[^}]*\}\s*from\b/;
const ANY_DEFAULT_RE =
  /(^|\n)\s*export\s+default\b|export\s*\{[^}]*\bdefault\b[^}]*\}/;

/** A barrel breaking the rule, and how. */
export interface DefaultExportProblem {
  barrel: string;
  kind: "missing" | "reexported";
}

export const defaultExportFold: FileFold<null, DefaultExportProblem[]> = {
  url: import.meta.url,
  scan(rawSrc, barrel) {
    // Fully mask comments, regex literals, AND string interiors: the three
    // regexes only detect code constructs (`export default`, `export { …
    // default … } from`), never read a string value — so masking strings
    // closes the string-embedded false-positive (a default-export shape
    // mentioned in a comment or string can't be mistaken for a real one).
    const src = maskSource(rawSrc);
    if (!ANY_DEFAULT_RE.test(src)) return [{ barrel, kind: "missing" }];
    if (REEXPORT_DEFAULT_RE.test(src) && !INLINE_DEFAULT_RE.test(src))
      return [{ barrel, kind: "reexported" }];
    return [];
  },
  combine: (parts) => parts.flat(),
};
