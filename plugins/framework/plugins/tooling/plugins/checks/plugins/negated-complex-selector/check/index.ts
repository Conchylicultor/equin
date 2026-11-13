import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { negatedComplexSelectorFold } from "./negated-complex-selector.scan";

/**
 * Rejects a `:not()` around a complex selector (`:not(.boundary *)`,
 * `:not(:where([data-x] *))`) in what becomes a stylesheet: plugin CSS, and the
 * Tailwind arbitrary variants (`[&:not(.x_*)]:p-2`, `_` read as a space) in
 * `.ts` / `.tsx`. A selector handed to `querySelector` / `matches` costs no
 * restyle, so plain strings are not scanned.
 *
 * Chrome invalidates the whole subtree under an element whose class or
 * attribute is named inside one, so toggling that state high in the tree
 * restyles the entire document: the `focus-ring` utilities' pointer-modality
 * negation cost 8,091 elements per keyboard ⇄ pointer flip on /agents, the
 * action bar's `:not(.floating-bar-boundary *)` ~20k per surface switch. The
 * positive ancestor form costs only the rule's subjects.
 */

// A fold check: each file's offending `:not()`s are its record
// (./negated-complex-selector.scan.ts), kept along the directory tree, so a
// pass after an edit reads only the edited files.
const check = defineFoldCheck({
  id: "negated-complex-selector",
  // INPUT-KEYED: the verdict is a function of the listed files' bytes (each
  // folded file's blob is recorded through the recording file set) and of
  // the listing under plugins/ — both replayed on the next run.
  inputKeyed: true,
  description:
    "No `:not()` around a complex selector (`:not(.x *)`) — Chrome restyles the whole subtree on every change of what it names; write the positive ancestor form",
  context: () => null,
  files: (repo) =>
    repo
      .under("plugins")
      .filter((p) => /\.(css|tsx?)$/.test(p) && !/\.test\.tsx?$/.test(p)),
  facts: () => null,
  fold: negatedComplexSelectorFold,
  verdict(offenders) {
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `\`:not()\` around a complex selector:\n${offenders.join("\n")}`,
      hint:
        "Chrome cannot narrow a class or attribute inside a complex :not() to the rule's " +
        "subject, so each change of it restyles the whole subtree below (the whole document " +
        "when it sits on <html>). Name the state as an ancestor instead: " +
        "`:where(:root:not([data-x])) .y` for `.y:not([data-x] *)`, or a plain descendant " +
        "rule (`.boundary .y`) that undoes the base rule.",
    };
  },
});

export default check;
