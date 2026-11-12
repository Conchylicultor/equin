import ts from "typescript";
import type { ExportRef } from "./probe-types";

// ── Where hand-written SQL lives in TypeScript source ───────────────────────
//
// A SITE is one literal that may hold a SQL write:
//   - a drizzle `sql`…`` tagged template (any tag spelled `sql` / `…Sql`, e.g.
//     `drizzleSql`), whose `${…}` holes drizzle renders as params, identifiers,
//     tables or nested fragments — so each hole is resolved below;
//   - an untagged string or template literal that reads as a statement (it
//     starts with WITH / INSERT / UPDATE / DELETE / MERGE) — what `pool.query`,
//     `sql.raw` and hand-written DDL take; its `${…}` holes are string
//     interpolation.
// Which literals are writes is decided by PARSING them (`statements.ts`); this
// file only finds candidates and says what each hole is.
//
// PER FILE, and nothing else: a file's sites are a function of its own bytes
// (so they fold — `sites.scan.ts`). A hole whose value lives in ANOTHER file (an
// import, or an export of this one only the probe can evaluate) is a
// `Deferred` here, and `resolve.ts` follows it across files afterwards — for
// the few holes that have one, never for every file.

/** What one `${…}` hole contributes to the statement text. */
export type Hole =
  /** Spliced verbatim: `sql.raw("…")`, a string constant in an untagged template. */
  | { readonly kind: "text"; readonly text: string }
  /** A quoted identifier: `sql.identifier("…")`. */
  | { readonly kind: "ident"; readonly name: string }
  /** An export of a schema file the probe evaluates (a table, a column, a string). */
  | { readonly kind: "export"; readonly ref: Omit<ExportRef, "id"> }
  /** Anything else: a value, or a name the source does not spell. */
  | { readonly kind: "opaque"; readonly expr: string };

export interface SqlSite {
  /** Repo-relative. */
  readonly file: string;
  readonly line: number;
  /** A drizzle `sql` tag (its holes render per kind) vs plain string interpolation. */
  readonly tagged: boolean;
  /** The static text: `chunks.length === holes.length + 1`. */
  readonly chunks: readonly string[];
  readonly holes: readonly Hole[];
  /**
   * Start offset of the `sql-writes:hand-written` marker comment binding this
   * site — on the literal or an enclosing node up to its statement — or null.
   */
  readonly marker: number | null;
}

/**
 * The site-level declaration of a hand-written write (see CLAUDE.md): a comment
 * that OPENS with the marker, so prose naming it is never one.
 */
export const HAND_WRITTEN_MARKER =
  /^(?:\/\/|\/\*+)\s*sql-writes:hand-written\b/;

/**
 * Offsets of every comment in `sf` carrying the marker — what a marker bound
 * to no site is found against. Read off the AST's comment ranges, so SQL text
 * inside a literal is never mistaken for a comment.
 */
export function markerComments(sf: ts.SourceFile): number[] {
  const text = sf.getFullText();
  const out = new Set<number>();
  const visit = (n: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [])
      if (HAND_WRITTEN_MARKER.test(text.slice(r.pos, r.end))) out.add(r.pos);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...out];
}

const LEAD =
  /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*\(?\s*(with|insert|update|delete|merge|create|alter)\b/i;
const WRITE =
  /\b(insert\s+into|delete\s+from|merge\s+into)\b|\bupdate\s+(only\s+)?\S+\s+(as\s+)?\S*\s*set\b/i;
// Hand-written DDL declares tables (model.ts reads it).
const DDL =
  /\bcreate\s+(?:(?:temp|temporary|unlogged)\s+)?table\b|\balter\s+table\b/i;

/** Whether `text` (holes as placeholders) may hold a SQL write or table DDL. */
export function mayMatter(text: string, tagged: boolean): boolean {
  return (WRITE.test(text) || DDL.test(text)) && (tagged || LEAD.test(text));
}

/**
 * The marker comment leading `node` or an ancestor of it, up to and including
 * the statement holding it (a write nested in a call, an object, a ternary is
 * bound by a comment on its statement).
 */
function markerOf(sf: ts.SourceFile, node: ts.Node): number | null {
  const text = sf.getFullText();
  for (
    let n: ts.Node | undefined = node;
    n && !ts.isSourceFile(n);
    n = n.parent
  ) {
    for (const r of ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [])
      if (HAND_WRITTEN_MARKER.test(text.slice(r.pos, r.end))) return r.pos;
    if (
      ts.isBlock(n.parent) ||
      ts.isSourceFile(n.parent) ||
      ts.isModuleBlock(n.parent)
    )
      break;
  }
  return null;
}

const isSqlTag = (tag: ts.Expression): boolean =>
  ts.isIdentifier(tag) && /^(sql|\w+Sql)$/.test(tag.text);

/**
 * A hole's value as far as its own file says: a constant (`string`, a
 * `raw` / `ident` fragment), nothing knowable (`unknown`), or a `Deferred`
 * value another file decides.
 */
export type Value =
  | { readonly kind: "string"; readonly value: string }
  /** A drizzle `sql.raw` / `sql.identifier` fragment of a constant string. */
  | { readonly kind: "raw" | "ident"; readonly value: string }
  | { readonly kind: "unknown" }
  | Deferred;

/** What another file decides — resolved by `resolve.ts` against the file it was read in. */
export type Deferred =
  /** Export `name` (then `path` into it) of the module `spec` names. */
  | {
      readonly kind: "import";
      readonly spec: string;
      readonly name: string;
      readonly path: readonly string[];
    }
  /**
   * This file's exported `const` `name` whose value the source does not
   * spell: the probe evaluates it when this file is a schema file.
   */
  | {
      readonly kind: "own-export";
      readonly name: string;
      readonly path: readonly string[];
    }
  /** A template: a string when every part is one. */
  | { readonly kind: "concat"; readonly parts: readonly (string | Value)[] }
  /** `sql.raw(x)` / `sql.identifier(x)` of a deferred `x`. */
  | {
      readonly kind: "wrap";
      readonly as: "raw" | "ident";
      readonly inner: Value;
    }
  /** `first`, unless it comes out unknown: then `orElse`. */
  | { readonly kind: "either"; readonly first: Value; readonly orElse: Value };

const UNKNOWN: Value = { kind: "unknown" };

/** A hole as its file's fold records it: final, or deferred to `resolve.ts`. */
export type ScannedHole =
  | Exclude<Hole, { kind: "export" }>
  | {
      readonly kind: "deferred";
      readonly value: Deferred;
      readonly expr: string;
    };

/** A site as its file's fold records it. */
export interface ScannedSite extends Omit<SqlSite, "holes"> {
  readonly holes: readonly ScannedHole[];
}

/** A marker comment: its offset (what a site's `marker` names) and its line. */
export interface Marker {
  readonly pos: number;
  readonly line: number;
}

/** One file's part: its sites and its marker comments. */
export interface FileSites {
  readonly sites: readonly ScannedSite[];
  readonly markers: readonly Marker[];
}

/**
 * Every site of one file and its marker comments, from its own bytes: holes
 * resolved within the file (a local `const`, `sql.raw` / `sql.identifier` of a
 * constant string, a property path), and deferred where another file decides.
 */
export function scanFileSites(sf: ts.SourceFile): FileSites {
  const rel = sf.fileName;
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (isCandidate(node)) {
      found.push(node);
      // A template's holes may hold nested sites of their own.
      if (
        !ts.isTaggedTemplateExpression(node) &&
        !ts.isTemplateExpression(node)
      )
        return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const sites: ScannedSite[] = [];
  for (const node of found) {
    const site = siteOf(sf, rel, node);
    if (site) sites.push(site);
  }
  const markers = markerComments(sf).map((pos) => ({
    pos,
    line: sf.getLineAndCharacterOfPosition(pos).line + 1,
  }));
  return { sites, markers };
}

function isCandidate(node: ts.Node): boolean {
  if (ts.isTaggedTemplateExpression(node)) return isSqlTag(node.tag);
  return (
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)) &&
    !ts.isTaggedTemplateExpression(node.parent) &&
    !ts.isImportDeclaration(node.parent) &&
    !ts.isExportDeclaration(node.parent)
  );
}

/** The site candidate `node` is, or null when its text can hold no write. */
function siteOf(
  sf: ts.SourceFile,
  file: string,
  node: ts.Node,
): ScannedSite | null {
  const tagged = ts.isTaggedTemplateExpression(node);
  const template = (tagged ? node.template : node) as
    ts.TemplateLiteral | ts.StringLiteral;
  const chunks: string[] = [];
  const exprs: ts.Expression[] = [];
  if (ts.isTemplateExpression(template)) {
    chunks.push(template.head.text);
    for (const span of template.templateSpans) {
      exprs.push(span.expression);
      chunks.push(span.literal.text);
    }
  } else chunks.push(template.text);
  const placeholder = chunks
    .map((c, i) => (i === 0 ? c : `__h${i - 1}__${c}`))
    .join("");
  if (!mayMatter(placeholder, tagged)) return null;
  const holes = exprs.map((e): ScannedHole => {
    const v = valueOf(sf, e, []);
    const expr = e.getText(sf);
    switch (v.kind) {
      case "string":
      case "raw":
      case "ident":
      case "unknown":
        return constantHole(v, tagged, expr);
      case "import":
      case "own-export":
      case "concat":
      case "wrap":
      case "either":
        return { kind: "deferred", value: v, expr };
    }
  });
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return {
    file,
    line: line + 1,
    tagged,
    chunks,
    holes,
    marker: markerOf(sf, node),
  };
}

/** A value no other file decides. */
export type Constant = Extract<
  Value,
  { kind: "string" | "raw" | "ident" | "unknown" }
>;

/** A constant value as the hole it fills. */
export function constantHole(
  v: Constant,
  tagged: boolean,
  expr: string,
): Exclude<Hole, { kind: "export" }> {
  switch (v.kind) {
    // A string in a drizzle tag is a bound param; in plain interpolation, text.
    case "string":
      return tagged
        ? { kind: "opaque", expr }
        : { kind: "text", text: v.value };
    case "raw":
      return { kind: "text", text: v.value };
    case "ident":
      return { kind: "ident", name: v.value };
    case "unknown":
      return { kind: "opaque", expr };
  }
}

// ── Syntactic evaluation, within one file ────────────────────────────────────

/** What `expr` evaluates to (then `path` into it), as far as `sf` says. */
export function valueOf(
  sf: ts.SourceFile,
  expr: ts.Expression,
  path: readonly string[],
): Value {
  const e = unwrap(expr);
  if (path.length === 0) {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
      return { kind: "string", value: e.text };
    if (ts.isTemplateExpression(e)) {
      const parts: (string | Value)[] = [e.head.text];
      for (const span of e.templateSpans) {
        const part = valueOf(sf, span.expression, []);
        if (part.kind === "string") parts.push(part.value);
        else if (
          part.kind === "unknown" ||
          part.kind === "raw" ||
          part.kind === "ident"
        )
          return UNKNOWN;
        else parts.push(part);
        parts.push(span.literal.text);
      }
      return parts.every((p) => typeof p === "string")
        ? { kind: "string", value: parts.join("") }
        : { kind: "concat", parts };
    }
  }
  // sql.raw("…") / sql.identifier("…") of a constant string.
  if (
    path.length === 0 &&
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    isSqlTag(e.expression.expression) &&
    (e.expression.name.text === "raw" ||
      e.expression.name.text === "identifier") &&
    e.arguments.length === 1
  ) {
    const as = e.expression.name.text === "raw" ? "raw" : "ident";
    const arg = valueOf(sf, e.arguments[0] as ts.Expression, []);
    if (arg.kind === "string") return { kind: as, value: arg.value };
    if (arg.kind === "unknown" || arg.kind === "raw" || arg.kind === "ident")
      return UNKNOWN;
    return { kind: "wrap", as, inner: arg };
  }
  if (ts.isPropertyAccessExpression(e))
    return valueOf(sf, e.expression, [e.name.text, ...path]);
  if (
    ts.isElementAccessExpression(e) &&
    ts.isStringLiteral(unwrap(e.argumentExpression))
  )
    return valueOf(sf, e.expression, [
      (unwrap(e.argumentExpression) as ts.StringLiteral).text,
      ...path,
    ]);
  if (ts.isObjectLiteralExpression(e) && path.length > 0) {
    const [head, ...rest] = path;
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) && propName(p.name) === head)
        return valueOf(sf, p.initializer, rest);
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === head)
        return valueOf(sf, p.name, rest);
    }
    return UNKNOWN;
  }
  if (ts.isIdentifier(e)) return bindingValue(sf, e, path);
  return UNKNOWN;
}

/** What identifier `id` is bound to, at its use in `sf` (then `path` into it). */
export function bindingValue(
  sf: ts.SourceFile,
  id: ts.Identifier,
  path: readonly string[],
): Value {
  const name = id.text;
  for (
    let scope: ts.Node | undefined = id.parent;
    scope;
    scope = scope.parent
  ) {
    // A parameter (or a loop / catch binding) is a runtime value.
    if (
      (ts.isFunctionLike(scope) &&
        scope.parameters.some((p) => bindsName(p.name, name))) ||
      ((ts.isForOfStatement(scope) ||
        ts.isForInStatement(scope) ||
        ts.isForStatement(scope)) &&
        scope.initializer !== undefined &&
        ts.isVariableDeclarationList(scope.initializer) &&
        scope.initializer.declarations.some((d) => bindsName(d.name, name))) ||
      (ts.isCatchClause(scope) &&
        scope.variableDeclaration !== undefined &&
        bindsName(scope.variableDeclaration.name, name))
    )
      return UNKNOWN;
    if (!(
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope)
    ))
      continue;
    for (const stmt of scope.statements) {
      // A function or class of that name, or a destructured binding of it,
      // shadows anything further out: a runtime value.
      if (
        (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
        stmt.name?.text === name
      )
        return UNKNOWN;
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) {
            if (bindsName(d.name, name)) return UNKNOWN;
            continue;
          }
          if (d.name.text !== name) continue;
          if (!(stmt.declarationList.flags & ts.NodeFlags.Const))
            return UNKNOWN;
          const local =
            d.initializer !== undefined
              ? valueOf(sf, d.initializer, path)
              : UNKNOWN;
          // An exported schema-file value: the probe evaluates it.
          const exported =
            ts.isSourceFile(scope) &&
            stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          const own: Value = exported
            ? { kind: "own-export", name, path }
            : UNKNOWN;
          if (local.kind === "unknown") return own;
          if (isFinal(local) || own.kind === "unknown") return local;
          return { kind: "either", first: local, orElse: own };
        }
      }
      if (ts.isSourceFile(scope) && ts.isImportDeclaration(stmt)) {
        const imported = importedValue(stmt, name, path);
        if (imported) return imported;
      }
    }
  }
  return UNKNOWN;
}

/** A value no other file can change. */
function isFinal(v: Value): boolean {
  return (
    v.kind === "string" ||
    v.kind === "raw" ||
    v.kind === "ident" ||
    v.kind === "unknown"
  );
}

function importedValue(
  stmt: ts.ImportDeclaration,
  name: string,
  path: readonly string[],
): Value | null {
  const clause = stmt.importClause;
  if (!clause || clause.isTypeOnly || !ts.isStringLiteral(stmt.moduleSpecifier))
    return null;
  const spec = stmt.moduleSpecifier.text;
  const bindings = clause.namedBindings;
  if (
    bindings &&
    ts.isNamespaceImport(bindings) &&
    bindings.name.text === name
  ) {
    const [exportName, ...rest] = path;
    if (exportName === undefined) return UNKNOWN;
    return { kind: "import", spec, name: exportName, path: rest };
  }
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) {
      if (el.name.text !== name) continue;
      return {
        kind: "import",
        spec,
        name: (el.propertyName ?? el.name).text,
        path,
      };
    }
  }
  return null;
}

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e)
    )
      e = e.expression;
    else return e;
  }
}

function bindsName(b: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name;
  return b.elements.some(
    (el) => !ts.isOmittedExpression(el) && bindsName(el.name, name),
  );
}

function propName(n: ts.PropertyName): string | null {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
}
