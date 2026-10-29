import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

// The tell of a whole-file import scanner: a `from` reaching a specifier's
// opening quote. In a regex SOURCE string `from` is typically preceded by the
// `b` of a `\b` escape, so we deliberately do NOT anchor a leading `\b` (that
// would defeat the real case). We match `from`, then any run of regex
// whitespace/anchor/group tokens (`\s*`, `\b`, `(`, `?:`, …), then a "quote
// indicator": a literal quote/backtick OR a character class containing one
// (e.g. `["']`). `import(`/`require(` (dynamic import, CJS) have no `from` and
// are intentionally out of scope — `findImports` doesn't cover them, so they
// stay hand-rolled over fully-masked source.
const FROM_QUOTE = /from(?:\\s[*+?]?|\\[bB]|[\s()?:])*(?:["'`]|\[[^\]]*["'`])/;
// Require the `import`/`export` keyword too, so a `from "<table>"` in a SQL
// parser (or any other non-module `from "…"` DSL) is NOT mistaken for an import
// scanner. The keyword is what makes this specifically an ES-module statement
// scanner — exactly what `findImports` owns.
const IMPORT_KEYWORD = /\b(?:import|export)\b/;

/**
 * Whether a regex source is a `import`/`export … from "<spec>"` scanner — the
 * shape `findImports` centralizes. A hand-rolled one over string-preserved text
 * (`maskSource(src, { strings: false })`) also matches an import written inside
 * a string/template literal — the string-embedding false positive.
 *
 * Requires BOTH the `import`/`export` keyword and a `from … quote` reach, so a
 * SQL `from "table"` parser is not flagged. Bare side-effect `import "<spec>"`
 * scanners (no `from`) and keyword-less `from "@plugins/…"` codemods are
 * intentionally not flagged — rare, and `findImports` covers them once switched.
 */
export function isImportScanSource(src: string): boolean {
  return IMPORT_KEYWORD.test(src) && FROM_QUOTE.test(src);
}

export default createRule({
  name: "no-adhoc-import-scan",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled whole-file `import … from \"…\"` scanner regexes " +
        "— route static-import scanning through the `findImports` primitive.",
    },
    schema: [],
    messages: {
      adhocImportScan:
        "This global regex scans for `import … from \"…\"` statements by hand. " +
        "A whole-file import scanner that keeps string interiors " +
        "(`maskSource(src, { strings: false })`) also matches an import written " +
        "INSIDE a string/template literal (a test fixture, a docs snippet, a " +
        "codegen template) — a silent false positive. Use `findImports(src)` " +
        "from @plugins/plugin-meta/plugins/parse-utils/core: it masks strings " +
        "fully and reads each specifier back by offset. For `git grep`-style " +
        "checks use `grepImports` from the checks core. For a construct outside " +
        "its scope (dynamic `import()`, `require()`) mask fully with " +
        "`maskSource(src)` and read the quote span by offset.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "Literal[regex]"(node) {
        // The footgun is WHOLE-FILE scanning — the `g` flag. A single-statement,
        // anchored parser (a trailing `from "…"$` matcher over one already-split
        // statement) is not global and is not the class.
        const regex = (node as { regex?: { pattern: string; flags: string } })
          .regex;
        if (!regex || !regex.flags.includes("g")) return;
        if (isImportScanSource(regex.pattern)) {
          context.report({ node, messageId: "adhocImportScan" });
        }
      },
    };
  },
});
