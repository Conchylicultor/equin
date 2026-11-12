import type TS from "typescript";
import {
  cannotRead,
  read,
  siteOf,
  unreadableAt,
  type Collected,
  type ParsedFile,
  type Readout,
  type SourceSite,
  type Unreadable,
} from "./result";

// The per-file half: every reference one file makes to a set of target
// declarations, read from its syntax tree and classified — a call, a member
// call, a re-export — or returned as Unreadable. Pure and synchronous, so a
// per-file cached scan (codegen's `FileScan`) can run it with no repo; the
// cross-file half (`analysis.ts`) feeds it a resolver built from real module
// resolution.

/** One reference to a target, in a form a reader can act on. */
export type TargetUse<K> =
  /** `f(…)`, `(f)(…)`, `ns.f(…)`, `f?.(…)` — `call.arguments` are the reader's to read. */
  | {
      kind: "call";
      key: K;
      exported: string;
      call: TS.CallExpression;
      file: ParsedFile;
      site: SourceSite;
    }
  /** `f.member(…)` — a target object's method (`Investigate.Register(…)`). */
  | {
      kind: "member-call";
      key: K;
      exported: string;
      member: string;
      call: TS.CallExpression;
      file: ParsedFile;
      site: SourceSite;
    }
  /** `export { f as as }` / `export { f as as } from "…"`: the target leaves under `as`. */
  | {
      kind: "reexport";
      key: K;
      exported: string;
      as: string;
      file: ParsedFile;
      site: SourceSite;
    }
  /** `export * from "…"` / `export * as as from "…"` of a module exporting a target. */
  | {
      kind: "reexport-all";
      specifier: string;
      as: string | null;
      file: ParsedFile;
      site: SourceSite;
    };

/** Which imports name a target — answered per module specifier, as written. */
export interface TargetResolver<K> {
  /** The target the export `exported` (`"default"` for a default import) of `specifier` is, if any. */
  imported(specifier: string, exported: string): K | undefined;
  /** Whether `specifier` exports any target — so a namespace of it, or `export *` of it, is tracked. */
  isTargetModule(specifier: string): boolean;
  /** A top-level declaration of THIS file that is itself a target (the declaring file's own uses). */
  local?(name: string): K | undefined;
}

interface Bound<K> {
  key: K;
  exported: string;
}

/**
 * Every reference `file` makes to a target `resolver` names, each read as a
 * {@link TargetUse} or returned as {@link Unreadable} — never skipped.
 *
 * Followed: named and aliased imports (`import { f as g }`), default imports,
 * namespace imports (`ns.f(…)`), re-exports, and the declaring file's own
 * top-level target. Unreadable: a reference passed, stored, spread or
 * destructured as a value; a namespace indexed (`ns[k]`) or used whole; a
 * `export default f`; a dynamic `import()` / `require()` of a target module; a declaration of the same name anywhere in the file
 * (shadowing — the reader would have to guess which binding each later use
 * means).
 *
 * Not references (skipped): property and member names, object keys, labels,
 * import specifiers themselves, and `typeof f` in a type.
 */
export function fileTargetUses<K>(
  ts: typeof TS,
  file: ParsedFile,
  resolver: TargetResolver<K>,
): Collected<TargetUse<K>> {
  const out: Collected<TargetUse<K>> = { found: [], unreadable: [] };
  const { sf } = file;
  const named = new Map<string, Bound<K>>();
  const namespaces = new Map<string, string>();
  /** Identifiers that declare a target (the declaring file's own), never a shadow. */
  const ownDeclarations = new Set<TS.Node>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name !== undefined) {
        const key = resolver.imported(spec, "default");
        if (key !== undefined)
          named.set(clause.name.text, { key, exported: "default" });
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        if (resolver.isTargetModule(spec))
          namespaces.set(bindings.name.text, spec);
        continue;
      }
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue;
        const exported = (el.propertyName ?? el.name).text;
        const key = resolver.imported(spec, exported);
        if (key !== undefined) named.set(el.name.text, { key, exported });
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly || stmt.moduleSpecifier === undefined) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        if (resolver.isTargetModule(spec))
          out.found.push({
            kind: "reexport-all",
            specifier: spec,
            as: clause === undefined ? null : clause.name.text,
            file,
            site: siteOf(file, stmt),
          });
        continue;
      }
      for (const el of clause.elements) {
        if (el.isTypeOnly) continue;
        const exported = (el.propertyName ?? el.name).text;
        const key = resolver.imported(spec, exported);
        if (key !== undefined)
          out.found.push({
            kind: "reexport",
            key,
            exported,
            as: el.name.text,
            file,
            site: siteOf(file, el),
          });
      }
      continue;
    }
    if (resolver.local === undefined) continue;
    for (const id of topLevelNames(ts, stmt)) {
      const key = resolver.local(id.text);
      if (key === undefined) continue;
      named.set(id.text, { key, exported: id.text });
      ownDeclarations.add(id);
    }
  }
  const classifyUse = (expr: TS.Expression, bound: Bound<K>): void => {
    let outer: TS.Expression = expr;
    while (
      ts.isParenthesizedExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent)
    )
      outer = outer.parent;
    const p = outer.parent;
    if (ts.isCallExpression(p) && p.expression === outer) {
      out.found.push({
        kind: "call",
        key: bound.key,
        exported: bound.exported,
        call: p,
        file,
        site: siteOf(file, p),
      });
      return;
    }
    if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === outer &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      out.found.push({
        kind: "member-call",
        key: bound.key,
        exported: bound.exported,
        member: p.name.text,
        call: p.parent,
        file,
        site: siteOf(file, p.parent),
      });
      return;
    }
    out.unreadable.push(
      unreadableAt(
        file,
        outer,
        `\`${expr.getText(sf)}\` is used other than called — passed, stored or spread as a value, it cannot be followed; call it directly.`,
      ),
    );
  };

  const visit = (node: TS.Node): void => {
    // `import("…")` / `require("…")` of a module exporting a target: what it
    // binds is a value the reader cannot follow.
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      resolver.isTargetModule(node.arguments[0].text)
    )
      out.unreadable.push(
        unreadableAt(
          file,
          node,
          `a module exporting a target is loaded dynamically; what it binds cannot be followed — import the target by name.`,
        ),
      );
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      resolver.isTargetModule(node.moduleReference.expression.text)
    )
      out.unreadable.push(
        unreadableAt(
          file,
          node,
          `\`import = require\` of a module exporting a target cannot be followed — import the target by name.`,
        ),
      );
    if (ts.isIdentifier(node)) {
      const bound = named.get(node.text);
      if (bound !== undefined) {
        if (isReference(ts, file, node, ownDeclarations, out.unreadable)) {
          const p = node.parent;
          if (ts.isExportSpecifier(p)) {
            out.found.push({
              kind: "reexport",
              key: bound.key,
              exported: bound.exported,
              as: p.name.text,
              file,
              site: siteOf(file, p),
            });
          } else if (ts.isExportAssignment(p)) {
            out.unreadable.push(
              unreadableAt(
                file,
                p,
                `\`${node.text}\` is default-exported; its importers name it anything — export it by name.`,
              ),
            );
          } else {
            classifyUse(node, bound);
          }
        }
      } else {
        const spec = namespaces.get(node.text);
        if (
          spec !== undefined &&
          isReference(ts, file, node, ownDeclarations, out.unreadable)
        ) {
          const p = node.parent;
          if (ts.isPropertyAccessExpression(p) && p.expression === node) {
            const key = resolver.imported(spec, p.name.text);
            if (key !== undefined)
              classifyUse(p, { key, exported: p.name.text });
          } else {
            out.unreadable.push(
              unreadableAt(
                file,
                ts.isElementAccessExpression(p) ? p : node,
                `the namespace \`${node.text}\` of "${spec}" is ${ts.isElementAccessExpression(p) ? "indexed" : "used as a value"}, so which of its exports are used cannot be read; access them by name (\`${node.text}.name(…)\`) or import them by name.`,
              ),
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Whether `id` (spelled like a bound name) refers to the binding. A spelling
 * that is not a reference (a member name, a key, the import itself, a type
 * query) answers false; a declaration of the same name records an Unreadable
 * (shadowing) and answers false.
 */
function isReference(
  ts: typeof TS,
  file: ParsedFile,
  id: TS.Identifier,
  ownDeclarations: ReadonlySet<TS.Node>,
  unreadable: Unreadable[],
): boolean {
  if (ownDeclarations.has(id)) return false;
  const role = identifierRole(ts, id);
  if (role === "declaration") {
    unreadable.push(
      unreadableAt(
        file,
        id,
        `\`${id.text}\` is declared again, shadowing the imported binding — which one each later use means cannot be read; rename it.`,
      ),
    );
    return false;
  }
  return role === "reference";
}

/**
 * What an identifier is where it stands: a `reference` to a binding (read,
 * called, assigned, a shorthand property's value), the name a `declaration`
 * introduces, or `other` — a member or key name, a label, an import or export
 * specifier's own name, a `typeof` in a type.
 */
export function identifierRole(
  ts: typeof TS,
  id: TS.Identifier,
): "reference" | "declaration" | "other" {
  const parent = id.parent;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isNamespaceExport(parent)
  )
    return "other";
  if (ts.isExportSpecifier(parent)) {
    // `export { a as b } from "…"` names the other module's exports; in a
    // local `export { a as b }`, only `a` is the reference.
    if (parent.parent.parent.moduleSpecifier !== undefined) return "other";
    return (parent.propertyName ?? parent.name) === id ? "reference" : "other";
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === id)
    return "other";
  if (ts.isQualifiedName(parent) && parent.right === id) return "other";
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isPropertyAccessChain(parent)) &&
    parent.name === id
  )
    return "other";
  if (ts.isBindingElement(parent) && parent.propertyName === id) return "other";
  if (
    (ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
    parent.label === id
  )
    return "other";
  // `typeof f` / `typeof ns.f` in a type: a type-level mention, not a use.
  let typeLevel: TS.Node = id;
  while (ts.isQualifiedName(typeLevel.parent)) typeLevel = typeLevel.parent;
  if (ts.isTypeQueryNode(typeLevel.parent)) return "other";
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isBindingElement(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === id
  )
    return "declaration";
  return "reference";
}

/**
 * Every identifier under `root` that reads a VALUE binding — what a reader
 * takes to its declaration with `bindingOf` (code it calls, passes, spreads,
 * returns). Type positions (annotations, type aliases, interfaces, type
 * arguments) are skipped whole: they name no runtime value.
 */
export function valueReferences(ts: typeof TS, root: TS.Node): TS.Identifier[] {
  const out: TS.Identifier[] = [];
  const visit = (node: TS.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node))
    )
      return;
    if (ts.isIdentifier(node)) {
      if (identifierRole(ts, node) === "reference") out.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** The names a top-level statement declares as values (functions, classes, enums, plain `const`/`let`/`var`). */
function topLevelNames(ts: typeof TS, stmt: TS.Statement): TS.Identifier[] {
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)) &&
    stmt.name !== undefined
  )
    return [stmt.name];
  if (ts.isVariableStatement(stmt))
    return stmt.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name] : [],
    );
  return [];
}

/**
 * The string an expression spells, when it is a literal: `"x"`, `'x'`,
 * `` `x` `` (no substitution), through parentheses, `as const` and
 * `satisfies`. Anything else — an identifier, a call, a template with `${}`,
 * a ternary — is Unreadable.
 */
export function literalString(
  ts: typeof TS,
  file: ParsedFile,
  expr: TS.Expression,
): Readout<string> {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
    return read(e.text);
  return cannotRead(
    file,
    expr,
    "not a string literal — the value is only known at runtime; write the literal at the call site.",
  );
}
