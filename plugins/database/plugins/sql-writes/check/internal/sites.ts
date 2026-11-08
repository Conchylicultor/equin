import ts from "typescript";
import { dirname, relative, resolve } from "path";
import { parsedTsSource } from "@plugins/framework/plugins/tooling/plugins/checks/core";
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

const isSqlTag = (tag: ts.Expression): boolean =>
  ts.isIdentifier(tag) && /^(sql|\w+Sql)$/.test(tag.text);

/**
 * Resolves `${…}` holes from the source alone: a local `const`, an import
 * followed through barrels' re-exports (`ts.resolveModuleName` with the repo's
 * own compiler options), a `sql.identifier` / `sql.raw` of a constant string.
 * A chain that ends at an export of a schema-glob file becomes an `export` hole
 * for the probe to evaluate; anything else is opaque.
 */
export class SiteScanner {
  private readonly files = new Map<string, ts.SourceFile>();

  constructor(
    private readonly root: string,
    private readonly options: ts.CompilerOptions,
    private readonly read: (abs: string) => string | null,
    /** Absolute schema-glob files: the exports the probe can evaluate. */
    private readonly schemaFiles: ReadonlySet<string>,
  ) {}

  async scan(relFile: string, text: string): Promise<SqlSite[]> {
    const sf = await this.parse(relFile, text);
    const found: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (this.isCandidate(node)) {
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
    const sites: SqlSite[] = [];
    for (const node of found) {
      const site = await this.siteOf(sf, relFile, node);
      if (site) sites.push(site);
    }
    return sites;
  }

  private isCandidate(node: ts.Node): boolean {
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
  private async siteOf(
    sf: ts.SourceFile,
    file: string,
    node: ts.Node,
  ): Promise<SqlSite | null> {
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
    const holes: Hole[] = [];
    for (const e of exprs) holes.push(await this.hole(sf, e, tagged));
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file, line: line + 1, tagged, chunks, holes };
  }

  private async hole(
    sf: ts.SourceFile,
    expr: ts.Expression,
    tagged: boolean,
  ): Promise<Hole> {
    const v = await this.value(sf, expr, []);
    switch (v.kind) {
      // A string in a drizzle tag is a bound param; in plain interpolation, text.
      case "string":
        return tagged
          ? { kind: "opaque", expr: expr.getText(sf) }
          : { kind: "text", text: v.value };
      case "raw":
        return { kind: "text", text: v.value };
      case "ident":
        return { kind: "ident", name: v.value };
      case "export":
        return { kind: "export", ref: v.ref };
      case "unknown":
        return { kind: "opaque", expr: expr.getText(sf) };
    }
  }

  // ── Syntactic evaluation ──────────────────────────────────────────────────

  private async value(
    sf: ts.SourceFile,
    expr: ts.Expression,
    path: string[],
  ): Promise<Value> {
    const e = unwrap(expr);
    if (path.length === 0) {
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
        return { kind: "string", value: e.text };
      if (ts.isTemplateExpression(e)) {
        let out = e.head.text;
        for (const span of e.templateSpans) {
          const part = await this.value(sf, span.expression, []);
          if (part.kind !== "string") return UNKNOWN;
          out += part.value + span.literal.text;
        }
        return { kind: "string", value: out };
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
      const arg = await this.value(sf, e.arguments[0] as ts.Expression, []);
      if (arg.kind !== "string") return UNKNOWN;
      return {
        kind: e.expression.name.text === "raw" ? "raw" : "ident",
        value: arg.value,
      };
    }
    if (ts.isPropertyAccessExpression(e))
      return await this.value(sf, e.expression, [e.name.text, ...path]);
    if (
      ts.isElementAccessExpression(e) &&
      ts.isStringLiteral(unwrap(e.argumentExpression))
    )
      return await this.value(sf, e.expression, [
        (unwrap(e.argumentExpression) as ts.StringLiteral).text,
        ...path,
      ]);
    if (ts.isObjectLiteralExpression(e) && path.length > 0) {
      const [head, ...rest] = path;
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && propName(p.name) === head)
          return await this.value(sf, p.initializer, rest);
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === head)
          return await this.value(sf, p.name, rest);
      }
      return UNKNOWN;
    }
    if (ts.isIdentifier(e)) return await this.binding(sf, e, path);
    return UNKNOWN;
  }

  /** What identifier `id` is bound to, at its use in `sf`. */
  private async binding(
    sf: ts.SourceFile,
    id: ts.Identifier,
    path: string[],
  ): Promise<Value> {
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
          scope.initializer.declarations.some((d) =>
            bindsName(d.name, name),
          )) ||
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
                ? await this.value(sf, d.initializer, path)
                : UNKNOWN;
            if (local.kind !== "unknown") return local;
            // An exported schema-file value: the probe evaluates it.
            const exported = stmt.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.ExportKeyword,
            );
            return ts.isSourceFile(scope) && exported
              ? this.exportRef(this.absOf(sf), name, path)
              : UNKNOWN;
          }
        }
        if (ts.isSourceFile(scope) && ts.isImportDeclaration(stmt)) {
          const imported = await this.imported(sf, stmt, name, path);
          if (imported) return imported;
        }
      }
    }
    return UNKNOWN;
  }

  private async imported(
    sf: ts.SourceFile,
    stmt: ts.ImportDeclaration,
    name: string,
    path: string[],
  ): Promise<Value | null> {
    const clause = stmt.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      !ts.isStringLiteral(stmt.moduleSpecifier)
    )
      return null;
    const target = this.resolveModule(
      this.absOf(sf),
      stmt.moduleSpecifier.text,
    );
    const bindings = clause.namedBindings;
    if (
      bindings &&
      ts.isNamespaceImport(bindings) &&
      bindings.name.text === name
    ) {
      const [exportName, ...rest] = path;
      if (!target || exportName === undefined) return UNKNOWN;
      return await this.exportValue(target, exportName, rest, 0);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.name.text !== name) continue;
        if (!target) return UNKNOWN;
        return await this.exportValue(
          target,
          (el.propertyName ?? el.name).text,
          path,
          0,
        );
      }
    }
    return null;
  }

  /** Export `name` of `file`, followed through re-exports. */
  private async exportValue(
    file: string,
    name: string,
    path: string[],
    depth: number,
  ): Promise<Value> {
    if (depth > 20) return UNKNOWN;
    const sf = await this.load(file);
    if (!sf) return UNKNOWN;
    for (const stmt of sf.statements) {
      if (
        ts.isVariableStatement(stmt) &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name)
            return await this.binding(sf, d.name, path);
        }
      }
      if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
        const from =
          stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
            ? this.resolveModule(file, stmt.moduleSpecifier.text)
            : null;
        const clause = stmt.exportClause;
        if (!clause) {
          // export * from "…"
          if (!from) continue;
          const v = await this.exportValue(from, name, path, depth + 1);
          if (v.kind !== "unknown") return v;
          continue;
        }
        if (!ts.isNamedExports(clause)) continue;
        for (const el of clause.elements) {
          if (el.name.text !== name) continue;
          const local = (el.propertyName ?? el.name).text;
          if (from) return await this.exportValue(from, local, path, depth + 1);
          const id = ts.factory.createIdentifier(local);
          // A local re-export (`export { x }`): resolve `x` at file scope.
          (id as { parent?: ts.Node }).parent = sf;
          return await this.binding(sf, id, path);
        }
      }
    }
    return UNKNOWN;
  }

  private exportRef(file: string, exportName: string, path: string[]): Value {
    return this.schemaFiles.has(file)
      ? { kind: "export", ref: { file, exportName, path } }
      : UNKNOWN;
  }

  private resolveModule(from: string, spec: string): string | null {
    const r = ts.resolveModuleName(spec, from, this.options, ts.sys);
    const f = r.resolvedModule?.resolvedFileName;
    return f && !f.includes("/node_modules/") ? f : null;
  }

  private async load(abs: string): Promise<ts.SourceFile | null> {
    const rel = relative(this.root, abs);
    const cached = this.files.get(rel);
    if (cached) return cached;
    const text = this.read(abs);
    return text === null ? null : this.parse(rel, text);
  }

  private async parse(rel: string, text: string): Promise<ts.SourceFile> {
    const sf = await parsedTsSource(ts, { rel, src: text });
    this.files.set(rel, sf);
    return sf;
  }

  private absOf(sf: ts.SourceFile): string {
    return resolve(this.root, sf.fileName);
  }
}

type Value =
  | { readonly kind: "string"; readonly value: string }
  /** A drizzle `sql.raw` / `sql.identifier` fragment of a constant string. */
  | { readonly kind: "raw" | "ident"; readonly value: string }
  | { readonly kind: "export"; readonly ref: Omit<ExportRef, "id"> }
  | { readonly kind: "unknown" };
const UNKNOWN: Value = { kind: "unknown" };

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

/** The repo's compiler options (for `paths`), read from its root tsconfig. */
export function repoCompilerOptions(root: string): ts.CompilerOptions {
  const configPath = resolve(root, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error)
    throw new Error(
      `sql-writes: cannot read ${configPath}: ${String(read.error.messageText)}`,
    );
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath))
    .options;
}
