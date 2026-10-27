// The rules behind `data-files:roots-bound` and `data-files:root-owner`, as
// pure functions over source text — so each is tested on literals, and the
// check only supplies the files.

import { posix } from "node:path";
import type TS from "typescript";

const MACHINE_BARREL =
  "@plugins/infra/plugins/paths/plugins/data-files/machine";
const SERVER_BARREL = "@plugins/infra/plugins/paths/plugins/data-files/server";

/** A module path's plugin and the runtime folder it sits in. */
const MODULE_RE = /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/([^/]+)\//;

export function pluginOfModule(
  rel: string,
): { plugin: string; folder: string } | null {
  const m = MODULE_RE.exec(rel);
  if (m === null) return null;
  return { plugin: m[1]!, folder: m[2]! };
}

/** One `defineFileRoot({ … })` call, as written. */
export interface RootDeclaration {
  /** The declaring module, repo-relative. */
  module: string;
  line: number;
  /** The declaring plugin's path (`apps/plugins/prototypes`). */
  plugin: string;
  /** The `const` the root is bound to — what a binding imports. */
  constName: string | null;
  id: string | null;
  dir: string | null;
}

/** One `FileRootLocation(<root>, <dataDir>)` call, with where `<root>` came from. */
export interface RootBinding {
  module: string;
  line: number;
  /** The plugin the root was imported from, or null when it names no import. */
  rootPlugin: string | null;
  /** The name the root is exported under there. */
  rootName: string | null;
}

function line(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Local import name → (specifier, imported name), for named and default imports. */
function importsOf(
  ts: typeof TS,
  sf: TS.SourceFile,
): Map<string, { from: string; name: string }> {
  const out = new Map<string, { from: string; name: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const from = stmt.moduleSpecifier.text;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      out.set(el.name.text, {
        from,
        name: (el.propertyName ?? el.name).text,
      });
    }
  }
  return out;
}

function visitCalls(
  ts: typeof TS,
  sf: TS.SourceFile,
  onCall: (call: TS.CallExpression) => void,
): void {
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) onCall(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function stringProp(
  ts: typeof TS,
  obj: TS.ObjectLiteralExpression,
  key: string,
): string | null {
  for (const p of obj.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === key &&
      (ts.isStringLiteral(p.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(p.initializer))
    ) {
      return p.initializer.text;
    }
  }
  return null;
}

/** Every `defineFileRoot(…)` call in a module (imported from the data-files server barrel). */
export function parseRootDeclarations(
  ts: typeof TS,
  rel: string,
  src: string,
): RootDeclaration[] {
  const owner = pluginOfModule(rel);
  if (owner === null) return [];
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const imports = importsOf(ts, sf);
  const out: RootDeclaration[] = [];
  visitCalls(ts, sf, (call) => {
    if (!ts.isIdentifier(call.expression)) return;
    const imported = imports.get(call.expression.text);
    if (imported?.from !== SERVER_BARREL || imported.name !== "defineFileRoot")
      return;
    const arg = call.arguments[0];
    const obj =
      arg !== undefined && ts.isObjectLiteralExpression(arg) ? arg : null;
    const parent = call.parent;
    out.push({
      module: rel,
      line: line(sf, call),
      plugin: owner.plugin,
      constName:
        ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
          ? parent.name.text
          : null,
      id: obj === null ? null : stringProp(ts, obj, "id"),
      dir: obj === null ? null : stringProp(ts, obj, "dir"),
    });
  });
  return out;
}

/**
 * The plugin a specifier names a server module of: `@plugins/<p>/server`, or a
 * relative path into some plugin's `server/` (a plugin's own halves import
 * each other relatively).
 */
function serverPluginOf(fromModule: string, spec: string): string | null {
  if (spec.startsWith("@plugins/")) {
    const m = /^@plugins\/(.+)\/server$/.exec(spec);
    return m === null ? null : m[1]!;
  }
  if (!spec.startsWith(".")) return null;
  const target = posix.join(posix.dirname(fromModule), spec);
  const owner = pluginOfModule(`${target}/`);
  return owner !== null && owner.folder === "server" ? owner.plugin : null;
}

/** Every `FileRootLocation(…)` call in a module (imported from the data-files machine barrel). */
export function parseRootBindings(
  ts: typeof TS,
  rel: string,
  src: string,
): RootBinding[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const imports = importsOf(ts, sf);
  const out: RootBinding[] = [];
  visitCalls(ts, sf, (call) => {
    if (!ts.isIdentifier(call.expression)) return;
    const imported = imports.get(call.expression.text);
    if (
      imported?.from !== MACHINE_BARREL ||
      imported.name !== "FileRootLocation"
    )
      return;
    const arg = call.arguments[0];
    const root =
      arg !== undefined && ts.isIdentifier(arg)
        ? imports.get(arg.text)
        : undefined;
    out.push({
      module: rel,
      line: line(sf, call),
      rootPlugin: root === undefined ? null : serverPluginOf(rel, root.from),
      rootName: root?.name ?? null,
    });
  });
  return out;
}

const where = (x: { module: string; line: number }): string =>
  `${x.module}:${x.line}`;

/**
 * `data-files:roots-bound`: every root is declared well-formed in a `server/`,
 * with a unique literal id, and bound by exactly one `FileRootLocation` in a
 * `machine/` — which imports it from the declaring plugin.
 */
export function rootsBoundProblems(
  decls: readonly RootDeclaration[],
  bindings: readonly RootBinding[],
): string[] {
  const problems: string[] = [];
  const ids = new Map<string, RootDeclaration>();
  for (const d of decls) {
    if (pluginOfModule(d.module)?.folder !== "server") {
      problems.push(
        `${where(d)} declares a file root outside a server/ — declare it in the owning plugin's server/ (a portable root, bound by its machine/)`,
      );
    }
    if (d.id === null || d.dir === null) {
      problems.push(
        `${where(d)} defineFileRoot needs an inline object literal with string-literal \`id\` and \`dir\``,
      );
    }
    if (d.constName === null) {
      problems.push(
        `${where(d)} defineFileRoot must be bound to a const (\`export const x = defineFileRoot(…)\`) — a binding imports it by name`,
      );
    }
    if (d.id !== null) {
      const prior = ids.get(d.id);
      if (prior !== undefined) {
        problems.push(
          `${where(d)} file root id "${d.id}" is also declared at ${where(prior)}`,
        );
      } else ids.set(d.id, d);
    }
  }
  for (const b of bindings) {
    if (pluginOfModule(b.module)?.folder !== "machine") {
      problems.push(
        `${where(b)} FileRootLocation outside a machine/ — a root's location is its owner's machine half's to give`,
      );
    }
    const matches = decls.filter(
      (d) => d.plugin === b.rootPlugin && d.constName === b.rootName,
    );
    if (matches.length === 0) {
      problems.push(
        `${where(b)} FileRootLocation's first argument is not a file root imported from the server/ that declares it`,
      );
    }
  }
  for (const d of decls) {
    if (d.constName === null) continue;
    const mine = bindings.filter(
      (b) => b.rootPlugin === d.plugin && b.rootName === d.constName,
    );
    if (mine.length === 1) continue;
    problems.push(
      mine.length === 0
        ? `${where(d)} file root "${d.id ?? d.constName}" has no FileRootLocation — contribute FileRootLocation(${d.constName}, <its data dir>) from plugins/${d.plugin}/machine/index.ts`
        : `${where(d)} file root "${d.id ?? d.constName}" is bound ${mine.length} times (${mine.map(where).join(", ")}) — a root lives in one place`,
    );
  }
  return problems;
}

/** The plugin and each of its ancestors, nearest first (`a/plugins/b` → `a/plugins/b`, `a`). */
export function selfAndAncestors(plugin: string): string[] {
  const out = [plugin];
  let p = plugin;
  for (
    let i = p.lastIndexOf("/plugins/");
    i !== -1;
    i = p.lastIndexOf("/plugins/")
  ) {
    p = p.slice(0, i);
    out.push(p);
  }
  return out;
}

/**
 * `data-files:root-owner`: a root's `dir` is a data dir declared (in its
 * `data-dirs/`) by the declaring plugin or one of its ancestors — a plugin
 * reaches only files its own subtree owns. `declaredDirs(plugin)` is the
 * `${kind}/${name}` set that plugin's `data-dirs/index.ts` declares.
 */
export function rootOwnerProblems(
  decls: readonly RootDeclaration[],
  declaredDirs: (plugin: string) => ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const d of decls) {
    if (d.dir === null) continue;
    const owners = selfAndAncestors(d.plugin);
    if (owners.some((p) => declaredDirs(p).has(d.dir!))) continue;
    problems.push(
      `${where(d)} file root "${d.id ?? d.constName}" names data dir "${d.dir}", which neither plugins/${d.plugin} nor an ancestor declares in its data-dirs/`,
    );
  }
  return problems;
}
