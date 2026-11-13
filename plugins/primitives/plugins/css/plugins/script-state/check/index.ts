import { foldRepoFiles } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { declarationsFold } from "./declarations.scan";
import { stylesheetReadsFold } from "./stylesheet-reads.scan";

/**
 * No stylesheet selects on a script-only state attribute — one declared with
 * `defineScriptState("data-…")` (`script-state/core`): page state on a
 * high-up element that flips often (`data-input-modality` on `<html>`, every
 * keyboard ⇄ pointer switch).
 *
 * A selector naming an ancestor's attribute makes Chrome restyle every element
 * the rule could match (or the whole subtree, under `:not()`) on each change
 * of it — ~7,000 `focus-ring` hosts per flip when the rings read
 * `data-input-modality`. Scans plugin CSS (any attribute selector) and the
 * Tailwind variants in `.ts` / `.tsx` / `.css` that compile to one. The set of
 * attributes is whatever the repo declares — nothing is listed here.
 */

/** A runtime folder's script, where state is declared (not check/, lint/, e2e/). */
const RUNTIME_SOURCE = /\/(web|core|shared)\/.*\.tsx?$/;

/** What becomes a stylesheet: plugin CSS and the Tailwind classes in script. */
function stylesheetSources(paths: readonly string[]): string[] {
  return paths.filter(
    (p) => /\.(css|tsx?)$/.test(p) && !/\.test\.tsx?$/.test(p),
  );
}

// A fold check over two folds, each kept along the directory tree so a pass
// after an edit reads only the edited files: the declared attributes
// (./declarations.scan.ts, over runtime sources) are the context of the reads
// fold (./stylesheet-reads.scan.ts, over every stylesheet source).
const check = defineFoldCheck({
  id: "script-state:no-stylesheet-reads",
  // INPUT-KEYED: the verdict is a function of the listed files' bytes (each
  // folded file's blob is recorded through the recording file set) and of
  // the listing under plugins/ — both replayed on the next run.
  inputKeyed: true,
  description:
    "No stylesheet (plugin CSS, Tailwind variant) selects on a script-only state attribute declared with defineScriptState — each flip would restyle every element the rule could match",
  async context(ctx) {
    const repo = await ctx.repo();
    const declared = await foldRepoFiles(
      repo,
      stylesheetSources(repo.under("plugins")).filter((p) =>
        RUNTIME_SOURCE.test(p),
      ),
      declarationsFold,
      null,
    );
    return {
      attributes: [...new Set(declared.attributes)].sort(),
      unreadable: declared.unreadable,
    };
  },
  files: (repo) => stylesheetSources(repo.under("plugins")),
  facts: () => null,
  fold: stylesheetReadsFold,
  verdict(offenders, { context }) {
    if (context.unreadable.length > 0) {
      return {
        ok: false,
        message: `defineScriptState called without a string-literal attribute:\n${context.unreadable.join("\n")}`,
        hint: 'Pass the attribute as a literal (`defineScriptState("data-x")`): the check reads it from the source.',
      };
    }
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `Stylesheet selects on a script-only state attribute:\n${offenders.join("\n")}`,
      hint:
        "These attributes flip often on a high-up element; a rule naming one restyles every " +
        "element it could match on each flip. Read the state in script and mark only the " +
        "element(s) it affects (focus-ring reads `data-pointer-focus` off the focused element, " +
        "not `data-input-modality` off <html>). See plugins/primitives/plugins/css/plugins/script-state.",
    };
  },
});

export default check;
