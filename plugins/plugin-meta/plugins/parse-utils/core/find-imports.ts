import { maskSource } from "./mask-source";

/**
 * The single static-import scanner every raw-text import scanner in the repo
 * should route through — the import-statement twin of `markerCallSpans`.
 *
 * ## The footgun it removes
 *
 * Import scanners want the module-specifier STRING (`from "@plugins/…"`), which
 * lives inside a string literal. The naive way to keep it is
 * `maskSource(src, { strings: false })` — mask comments/regex but NOT strings —
 * then regex `import … from "…"` over the result. That works for real imports
 * but ALSO matches an import statement written *inside* a string or template
 * literal (a test fixture embedding `import { X } from "../../core"` as sample
 * source, a docs snippet, a codegen template). The scanner reports fixture data
 * as a real import.
 *
 * `findImports` closes that hole structurally. It masks strings FULLY (so an
 * import embedded in a string is blanked away and can never match), matches the
 * import STRUCTURE (the `import`/`export`/`from` keywords and the quote
 * delimiters, which are genuine code) against the masked text, then reads the
 * specifier back from the ORIGINAL source at the preserved offset — the exact
 * mask-then-read-by-offset pattern `maskSource`'s contract is built for.
 *
 * ## Scope
 *
 * Matches static `import … from "…"`, `export … from "…"`, and bare side-effect
 * `import "…"`. Dynamic `import("…")` is a call, not a static import, and is
 * intentionally NOT matched (scan those with `markerCallSpans` if ever needed).
 * The bindings clause is excluded from crossing a `;` or a quote, so a match can
 * never span two statements.
 */
export interface ImportRef {
  /** The module specifier text (between the quotes), read from the ORIGINAL source. */
  specifier: string;
  /** Offset of the specifier's first char (just inside the opening quote) in the ORIGINAL source. */
  index: number;
  /** The leading keyword of the statement. */
  keyword: "import" | "export";
  /**
   * The bindings/clause text between the keyword and `from`, read from the
   * MASKED source (so identifiers survive but any string/comment interior is
   * blanked). Empty string for a bare side-effect import.
   */
  clause: string;
  /** Whole-statement type-only form: `import type …` / `export type …`. */
  typeOnly: boolean;
  /** Bare side-effect import (`import "x"`): no bindings, no `from`. */
  sideEffect: boolean;
}

// `import`/`export … from "<spec>"`, capturing the keyword, the bindings clause
// (used for type-only detection and symbol parsing), and the opening quote. The
// clause excludes quotes/backticks/`;` so a match can never cross a statement
// boundary or absorb an intervening string. Runs over MASKED source, so a `from`
// or quote inside a string/comment is already blanked and cannot match.
const FROM_RE = /\b(import|export)\b([^"'`;]*?)\bfrom\s*(["'`])/g;

// Bare side-effect import: `import "<spec>"` — the quote follows the keyword
// with only whitespace between (no bindings, no `from`). Disjoint from FROM_RE,
// whose `import` is always followed by a binding clause, not a quote.
const SIDE_EFFECT_RE = /\bimport\b\s*(["'`])/g;

/**
 * Extract every static import/export-from and bare side-effect import from
 * `src`, in source order. `src` is the RAW (unmasked) source — masking happens
 * internally, so callers never touch `maskSource` for import scanning. A caller
 * that already holds `maskSource(src)` passes it as `masked` (a scan reading
 * one file many ways masks it once); it must be exactly that.
 */
export function findImports(
  src: string,
  masked: string = maskSource(src),
): ImportRef[] {
  const out: ImportRef[] = [];

  // Reads the specifier from the ORIGINAL source given the opening-quote offset.
  // The closing delimiter is located in the MASKED text: the interior is all
  // spaces there, so the next quote char is unambiguously the real closing
  // delimiter (an escaped quote inside the string was blanked by maskSource and
  // is never mistaken for it). Returns null for an unterminated string.
  const readSpec = (openQuoteIdx: number): { specifier: string; index: number } | null => {
    const quote = masked[openQuoteIdx]!;
    const closeIdx = masked.indexOf(quote, openQuoteIdx + 1);
    if (closeIdx < 0) return null;
    return { specifier: src.slice(openQuoteIdx + 1, closeIdx), index: openQuoteIdx + 1 };
  };

  FROM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_RE.exec(masked))) {
    const openQuoteIdx = m.index + m[0].length - 1;
    const spec = readSpec(openQuoteIdx);
    if (!spec) continue;
    const clause = m[2]!;
    out.push({
      specifier: spec.specifier,
      index: spec.index,
      keyword: m[1] as "import" | "export",
      clause,
      typeOnly: /^\s*type\b/.test(clause),
      sideEffect: false,
    });
  }

  SIDE_EFFECT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_RE.exec(masked))) {
    const openQuoteIdx = m.index + m[0].length - 1;
    const spec = readSpec(openQuoteIdx);
    if (!spec) continue;
    out.push({
      specifier: spec.specifier,
      index: spec.index,
      keyword: "import",
      clause: "",
      typeOnly: false,
      sideEffect: true,
    });
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}
