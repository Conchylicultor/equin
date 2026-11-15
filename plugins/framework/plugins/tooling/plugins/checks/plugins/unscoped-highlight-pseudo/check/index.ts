import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { unscopedHighlightFold } from "./unscoped-highlight-pseudo.scan";

/**
 * Rejects a `::highlight(name)` rule in plugin CSS whose originating element
 * is any element (`::highlight(x)`, `*::highlight(x)`, `.a ::highlight(x)`).
 *
 * Chrome computes a matching highlight pseudo-element style for every element
 * such a rule matches, on every style recalc — whether or not a highlight of
 * that name is registered. Seven of them (the page editor's text span, the
 * streaming tail's six tiers) made a full recalc of a 17k-element
 * agent-manager page cost 390 ms instead of 111 ms; opening a long page beside
 * a conversation pays two such recalcs. Scoped to the element the highlight's
 * ranges live in, the text below it inherits the style (highlight
 * inheritance) and the rule costs ~3 ms.
 */

// A fold check: each file's offending rules are its record
// (./unscoped-highlight-pseudo.scan.ts), kept along the directory tree, so a
// pass after an edit reads only the edited files.
const check = defineFoldCheck({
  id: "unscoped-highlight-pseudo",
  // INPUT-KEYED: the verdict is a function of the listed files' bytes (each
  // folded file's blob is recorded through the recording file set) and of
  // the listing under plugins/ — both replayed on the next run.
  inputKeyed: true,
  description:
    "No unscoped `::highlight()` rule — every element it matches computes the highlight style on every style recalc; scope it to the element its ranges live in",
  context: () => null,
  files: (repo) => repo.under("plugins").filter((p) => p.endsWith(".css")),
  facts: () => null,
  fold: unscopedHighlightFold,
  verdict(offenders) {
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `\`::highlight()\` on every element:\n${offenders.join("\n")}`,
      hint:
        "An unscoped `::highlight(name)` matches every element of the document, and Chrome " +
        "computes its style for each one on every style recalc (~40 ms per rule on a " +
        "17k-element page). Scope it to the element the highlight's ranges live in " +
        "(`[data-lexical-editor]::highlight(name)`): the text below inherits it.",
    };
  },
});

export default check;
