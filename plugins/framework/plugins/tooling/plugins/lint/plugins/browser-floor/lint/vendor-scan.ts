/**
 * The regular expressions of one bundled JS file held to the floor — the pure
 * half of the `browser-floor:vendor-sets` probe (`vendor-scan-probe.ts`).
 *
 * npm code is plain JS, as esbuild bundled it: no types, no lint. So the file
 * is parsed with TypeScript's parser (no program, no checker), and every regex
 * literal and every `new RegExp(…)` / `RegExp(…)` with literal flags is given
 * the lint rule's own verdict (`regexpAboveFloor`). A flag inside a `try`
 * block (its throw caught: a feature test) or behind a test naming its
 * `RegExp` member (`"unicodeSets" in RegExp.prototype ? … : …`) passes.
 */
import ts from "typescript";
import type { AboveFloorTable } from "./above-floor";
import { regexpAboveFloor } from "./regexp-above-floor";

/** One regex of the file the floor lacks something for. */
export interface ChunkHit {
  /** 1-based, in the file. */
  line: number;
  column: number;
  /** The regex as written, cut to 120 characters. */
  regex: string;
  /** "uses the `unicodeSets` flag — missing in Safari 17, … (key)", or a parse error. */
  problem: string;
}

export interface ChunkScan {
  regexes: number;
  hits: ChunkHit[];
}

function literalString(n: ts.Expression | undefined): string | undefined {
  if (n === undefined) return undefined;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    return n.text;
  return undefined;
}

/** Inside the `try` block of a try statement (same function): its throw is caught. */
function insideTry(node: ts.Node): boolean {
  for (let n: ts.Node = node; n.parent !== undefined; n = n.parent) {
    if (ts.isTryStatement(n.parent) && n.parent.tryBlock === n) return true;
    if (ts.isFunctionLike(n)) return false;
  }
  return false;
}

/**
 * Behind a test naming the flag's member: the test of an enclosing `?:` or
 * `if`, or the left of an `&&`, mentions `member` (same function).
 */
function memberTested(
  node: ts.Node,
  member: string,
  sf: ts.SourceFile,
): boolean {
  for (let n: ts.Node = node; n.parent !== undefined; n = n.parent) {
    const p = n.parent;
    const test =
      ts.isConditionalExpression(p) && p.condition !== n
        ? p.condition
        : ts.isIfStatement(p) && p.expression !== n
          ? p.expression
          : ts.isBinaryExpression(p) &&
              p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
              p.right === n
            ? p.left
            : undefined;
    if (test?.getText(sf).includes(member) === true) return true;
    if (ts.isFunctionLike(p)) return false;
  }
  return false;
}

/** Every regex of `text` above the floor. */
export function scanChunk(
  name: string,
  text: string,
  table: AboveFloorTable,
): ChunkScan {
  const sf = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const hits: ChunkHit[] = [];
  let regexes = 0;
  const check = (
    node: ts.Node,
    pattern: string,
    flags: string,
    raw: string,
  ) => {
    regexes++;
    // Created inside a `try`: whatever it throws is caught — a feature test.
    if (insideTry(node)) return;
    const verdict = regexpAboveFloor(pattern, flags, table);
    const problems = verdict.ok
      ? verdict.hits
          .filter(
            (h) => h.member === undefined || !memberTested(node, h.member, sf),
          )
          .map(
            (h) => `uses ${h.what} — missing in ${h.hit.needs} (${h.hit.key})`,
          )
      : [`does not parse: ${verdict.error}`];
    if (problems.length === 0) return;
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    for (const problem of problems)
      hits.push({
        line: pos.line + 1,
        column: pos.character + 1,
        regex: raw.length > 120 ? `${raw.slice(0, 117)}…` : raw,
        problem,
      });
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const raw = (node as ts.RegularExpressionLiteral).text;
      const slash = raw.lastIndexOf("/");
      check(node, raw.slice(1, slash), raw.slice(slash + 1), raw);
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp"
    ) {
      const [source, flagsArg] = node.arguments ?? [];
      const regexSource =
        source?.kind === ts.SyntaxKind.RegularExpressionLiteral;
      // A regex literal source is checked as the literal it is; the call
      // again only when it passes other flags. A computed source still has
      // its literal flags checked.
      if (!(regexSource && flagsArg === undefined)) {
        const flags = flagsArg === undefined ? "" : literalString(flagsArg);
        if (flags !== undefined)
          check(
            node,
            regexSource ? "" : (literalString(source) ?? ""),
            flags,
            node.getText(sf),
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { regexes, hits };
}

// ── sourcemaps: which npm file a chunk position came from ───────────────────

const B64 = new Map(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map(
    (c, i) => [c, i],
  ),
);

/**
 * The `sources` index of the mapping segment covering (line, column), both
 * 1-based — the last segment of that line starting at or before the column —
 * or -1 when none does.
 */
export function sourceIndexAt(
  mappings: string,
  line: number,
  column: number,
): number {
  let source = 0;
  let found = -1;
  const lines = mappings.split(";");
  for (let l = 0; l < line && l < lines.length; l++) {
    let col = 0;
    const last = l === line - 1;
    if (last) found = -1;
    for (const seg of lines[l]!.split(",")) {
      if (seg === "") continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const digit = B64.get(ch);
        if (digit === undefined)
          throw new Error(`sourcemap: not a base64 VLQ digit: ${ch}`);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      col += fields[0] ?? 0;
      if (fields.length >= 4) source += fields[1]!;
      if (!last) continue;
      if (col > column - 1) break;
      found = fields.length >= 4 ? source : -1;
    }
  }
  return found;
}

/**
 * A source path as a reader names it: from its last `node_modules/` on
 * (`node_modules/@scope/pkg/dist/x.js`), else as the map spells it.
 */
export function npmSourceName(source: string): string {
  const at = source.lastIndexOf("node_modules/");
  return at < 0 ? source : source.slice(at);
}
