/**
 * The masker's sync oracle: where `maskSource` disagrees with TypeScript's own
 * parse of a file. `maskSource` is a one-pass lexer heuristic with no AST, so
 * a construct it misreads (an apostrophe in JSX text, a `/` after `x!`) does
 * not fail — it flips which spans read as literal and which as code for the
 * REST of the file, and every masked scanner (grepCode checks, findImports,
 * marker scans, lint rules) silently gets a wrong answer there. A check left
 * green for months that never ran was such a file.
 *
 * Two facts the parse settles and the masked text must agree with:
 *   - code stays code: every identifier outside a template literal is left
 *     unmasked, byte for byte;
 *   - literals are blanked: the interior of every string, no-substitution
 *     template and JSX text, and the whole of every regex literal, is spaces.
 * (Identifiers inside a template's `${ … }` are blanked with the template's
 * interior, so they are not code to the masker; they are skipped.)
 */

import type TS from "typescript";

/** The first place a file's mask disagrees with its parse. */
export interface MaskDivergence {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /**
   * `code-masked`: an identifier the parse reads as code is blanked;
   * `literal-exposed`: a literal's content is left as code.
   */
  kind: "code-masked" | "literal-exposed";
  /** The node's source text, clipped. */
  text: string;
}

/**
 * The first divergence between `masked` (= `maskSource(src)`, strings masked)
 * and `sf` (TypeScript's parse of `src`), in source order; null when they
 * agree everywhere.
 */
export function maskDivergence(
  ts: typeof TS,
  sf: TS.SourceFile,
  src: string,
  masked: string,
): MaskDivergence | null {
  const K = ts.SyntaxKind;
  let found: MaskDivergence | null = null;

  const report = (node: TS.Node, kind: MaskDivergence["kind"]): void => {
    const start = node.getStart(sf);
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    const text = src.slice(start, node.end);
    found = {
      line: line + 1,
      column: character + 1,
      kind,
      text: text.length > 60 ? `${text.slice(0, 57)}…` : text,
    };
  };

  /** Whether `masked` is all whitespace over [from, to). */
  const blank = (from: number, to: number): boolean =>
    masked.slice(from, to).trim() === "";

  const visit = (node: TS.Node, inTemplate: boolean): void => {
    if (found) return;
    const kind = node.kind;
    if (kind === K.Identifier || kind === K.PrivateIdentifier) {
      const start = node.getStart(sf);
      if (
        !inTemplate &&
        masked.slice(start, node.end) !== src.slice(start, node.end)
      )
        return report(node, "code-masked");
    } else if (
      kind === K.StringLiteral ||
      kind === K.NoSubstitutionTemplateLiteral
    ) {
      if (!blank(node.getStart(sf) + 1, node.end - 1))
        return report(node, "literal-exposed");
    } else if (kind === K.JsxText || kind === K.RegularExpressionLiteral) {
      if (!blank(node.getStart(sf), node.end))
        return report(node, "literal-exposed");
    }
    const template =
      inTemplate ||
      node.kind === K.TemplateExpression ||
      node.kind === K.TemplateLiteralType;
    ts.forEachChild(node, (child) => visit(child, template));
  };

  visit(sf, false);
  return found;
}
