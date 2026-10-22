/**
 * What counts as a PLATFORM API: a module that only exists on a host process —
 * the computer's filesystem, processes, sockets, native addons, the Postgres
 * client and the job queue built on it. Code that must run on every host (the
 * desktop backend and the browser) may not import one; the folders that must
 * are the `forbidden` rows of `platformApis` in `./boundary-config`.
 *
 * Plain data, read by two consumers that must agree: the
 * `boundaries/no-platform-api` lint rule (one file's own imports) and the
 * `boundaries:portable-closure` check (every module a portable server barrel
 * loads). It imports nothing at run time, so a lint rule can load it under
 * jiti: the value-use pass below takes the `typescript` module as an argument
 * (callers load it lazily — import-closure's `loadTypescript`).
 */

import type TS from "typescript";

/** Specifier prefixes that are platform APIs whatever follows them. */
const PLATFORM_PREFIXES = ["node:", "bun:"] as const;

/**
 * The unprefixed Node builtins (`isBuiltin`'s bare names, by their first
 * segment — `fs` also covers `fs/promises`). Spelled out rather than read from
 * `node:module`, which this file may not import; `platform-apis.test.ts` holds
 * the list to the runtime's own `builtinModules`.
 */
export const NODE_BUILTIN_ROOTS = [
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
] as const;

/**
 * npm packages (and Bun's own module) that are platform APIs, matched as the
 * package itself or any subpath of it.
 */
const PLATFORM_PACKAGES = [
  "bun",
  "bun-pty",
  "pg",
  "@parcel/watcher",
  "drizzle-orm/node-postgres",
  ...NODE_BUILTIN_ROOTS,
] as const;

/** Package-name prefixes: every `pg-*` package and graphile-worker's family. */
const PLATFORM_PACKAGE_PREFIXES = ["pg-", "graphile-worker"] as const;

/** Whether importing `specifier` reaches a platform API. */
export function isPlatformApi(specifier: string): boolean {
  if (PLATFORM_PREFIXES.some((p) => specifier.startsWith(p))) return true;
  if (
    PLATFORM_PACKAGES.some(
      (p) => specifier === p || specifier.startsWith(`${p}/`),
    )
  ) {
    return true;
  }
  return PLATFORM_PACKAGE_PREFIXES.some((p) => specifier.startsWith(p));
}

/**
 * Host-process globals a portable module may not READ: they exist under Bun
 * and Node and are undefined in a browser realm, so an import-clean module
 * using one still throws there at run time — `Buffer.from(…)`,
 * `z.instanceof(Buffer)`, `process.memoryUsage()`, `Bun.hash(…)`,
 * `opts.defer ?? setImmediate`.
 */
const PLATFORM_GLOBALS: ReadonlySet<string> = new Set([
  "Buffer",
  "Bun",
  "process",
  "__dirname",
  "__filename",
  "setImmediate",
  "require",
]);

/**
 * The host-only VALUE uses in one module's source, each as a label
 * (`global Buffer`, `unguarded .unref()`), deduplicated in first-use order.
 * Read from the TypeScript AST, so strings and comments never count, and only
 * a value use is one:
 *
 * - a platform global READ as a value — called, member-accessed, passed or
 *   stored (`Buffer.from(b)`, `z.instanceof(Buffer)`, `x ?? setImmediate`,
 *   `{ setImmediate }`). Not one: a type position (`interface Buffer`,
 *   `Map<string, Buffer>`, `setImmediate?: …`), a property or destructuring
 *   key (`x.process`, `{ setImmediate: immediate } = globalThis`), a
 *   declaration's own name, a `typeof` probe (it never throws), a name a
 *   local value binding shadows, and `process.env.NODE_ENV` (every bundler
 *   replaces it at build time).
 * - an UNGUARDED `.unref()` call. A Node/Bun timer has one; a browser's
 *   `setTimeout` returns a number, so the call throws there. The guarded
 *   `(t as { unref?: () => void }).unref?.()` is not a use.
 */
export function platformValueUsesIn(
  ts: typeof TS,
  fileName: string,
  source: string,
): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const found = new Set<string>();
  const visit = (node: TS.Node): void => {
    if (
      ts.isIdentifier(node) &&
      PLATFORM_GLOBALS.has(node.text) &&
      isGlobalValueRead(ts, node)
    ) {
      found.add(`global ${node.text}`);
    } else if (
      ts.isCallExpression(node) &&
      node.questionDotToken === undefined &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "unref"
    ) {
      found.add("unguarded .unref()");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found];
}

/** Whether `id` (a platform global's name) is a value read of the global itself. */
function isGlobalValueRead(ts: typeof TS, id: TS.Identifier): boolean {
  const parent = id.parent;
  if (isNameSlot(ts, id, parent)) return false;
  if (ts.isTypeOfExpression(parent)) return false;
  if (inTypePosition(ts, id)) return false;
  if (id.text === "process" && isNodeEnvRead(ts, id)) return false;
  return !isShadowed(ts, id);
}

/**
 * Whether `id` names something rather than reading a value: a member name
 * (`x.process`), a key (`{ setImmediate: f }`, `{ Buffer: b } = …`), a
 * declaration's own name (`const process = …`, `setImmediate?: …`), an
 * import/export alias or a label. A shorthand `{ setImmediate }` in an object
 * literal is NOT one — it reads the variable.
 */
function isNameSlot(
  ts: typeof TS,
  id: TS.Identifier,
  parent: TS.Node,
): boolean {
  if (ts.isPropertyAccessExpression(parent)) return parent.name === id;
  if (ts.isQualifiedName(parent)) return true;
  if (ts.isBindingElement(parent))
    return parent.propertyName === id || parent.name === id;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (
    ts.isBreakOrContinueStatement(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isMetaProperty(parent) ||
    ts.isJsxAttribute(parent)
  )
    return true;
  const named = parent as { name?: TS.Node };
  return named.name === id && namedDeclarationKinds(ts).has(parent.kind);
}

let declarationKinds: ReadonlySet<TS.SyntaxKind> | undefined;

/** The node kinds whose `name` is the declaration's own name (never a read). */
function namedDeclarationKinds(ts: typeof TS): ReadonlySet<TS.SyntaxKind> {
  const k = ts.SyntaxKind;
  return (declarationKinds ??= new Set([
    k.VariableDeclaration,
    k.Parameter,
    k.FunctionDeclaration,
    k.FunctionExpression,
    k.ClassDeclaration,
    k.ClassExpression,
    k.InterfaceDeclaration,
    k.TypeAliasDeclaration,
    k.EnumDeclaration,
    k.EnumMember,
    k.ModuleDeclaration,
    k.ImportClause,
    k.NamespaceImport,
    k.NamespaceExport,
    k.ImportEqualsDeclaration,
    k.PropertyDeclaration,
    k.PropertySignature,
    k.MethodDeclaration,
    k.MethodSignature,
    k.PropertyAssignment,
    k.GetAccessor,
    k.SetAccessor,
    k.TypeParameter,
  ]));
}

/**
 * Whether `id` sits in a type: a type node (`Map<string, Buffer>`,
 * `typeof setImmediate` in a type), or an interface or type alias. A class's
 * `extends` clause is the exception — its expression is a value.
 */
function inTypePosition(ts: typeof TS, id: TS.Identifier): boolean {
  for (let n: TS.Node = id.parent; !ts.isSourceFile(n); n = n.parent) {
    if (
      ts.isExpressionWithTypeArguments(n) &&
      ts.isHeritageClause(n.parent) &&
      n.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      ts.isClassLike(n.parent.parent)
    )
      return false;
    if (
      ts.isTypeNode(n) ||
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isHeritageClause(n)
    )
      return true;
    if (ts.isStatement(n)) return false;
  }
  return false;
}

/** `process.env.NODE_ENV`, which every bundler replaces at build time. */
function isNodeEnvRead(ts: typeof TS, id: TS.Identifier): boolean {
  const env = id.parent;
  if (!ts.isPropertyAccessExpression(env) || env.name.text !== "env")
    return false;
  const read = env.parent;
  return (
    ts.isPropertyAccessExpression(read) &&
    read.expression === env &&
    read.name.text === "NODE_ENV"
  );
}

/**
 * Whether a local VALUE binding of `id`'s name is in scope at `id` (a
 * parameter `process`, an imported `Buffer`, a `const setImmediate`), so it
 * reads that binding, not the global. A type (`interface Buffer`) or a
 * type-only import binds no value.
 */
function isShadowed(ts: typeof TS, id: TS.Identifier): boolean {
  const name = id.text;
  for (let n: TS.Node = id.parent; ; n = n.parent) {
    if (scopeDeclares(ts, n, name)) return true;
    if (ts.isSourceFile(n)) return false;
  }
}

function scopeDeclares(ts: typeof TS, scope: TS.Node, name: string): boolean {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope))
    return scope.statements.some((s) => statementDeclares(ts, s, name));
  if (ts.isCaseClause(scope) || ts.isDefaultClause(scope))
    return scope.statements.some((s) => statementDeclares(ts, s, name));
  if (ts.isFunctionLike(scope)) {
    if (ts.isFunctionExpression(scope) && scope.name?.text === name)
      return true;
    return scope.parameters.some((p) => bindsName(ts, p.name, name));
  }
  if (ts.isClassExpression(scope)) return scope.name?.text === name;
  if (
    ts.isForStatement(scope) ||
    ts.isForInStatement(scope) ||
    ts.isForOfStatement(scope)
  ) {
    const init = scope.initializer;
    return (
      init !== undefined &&
      ts.isVariableDeclarationList(init) &&
      init.declarations.some((d) => bindsName(ts, d.name, name))
    );
  }
  if (ts.isCatchClause(scope))
    return (
      scope.variableDeclaration !== undefined &&
      bindsName(ts, scope.variableDeclaration.name, name)
    );
  return false;
}

function statementDeclares(
  ts: typeof TS,
  s: TS.Statement,
  name: string,
): boolean {
  if (ts.isVariableStatement(s))
    return s.declarationList.declarations.some((d) =>
      bindsName(ts, d.name, name),
    );
  if (
    ts.isFunctionDeclaration(s) ||
    ts.isClassDeclaration(s) ||
    ts.isEnumDeclaration(s)
  )
    return s.name?.text === name;
  if (ts.isImportEqualsDeclaration(s))
    return !s.isTypeOnly && s.name.text === name;
  if (ts.isImportDeclaration(s)) {
    const clause = s.importClause;
    if (clause === undefined || clause.isTypeOnly) return false;
    if (clause.name?.text === name) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return false;
    if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
    return bindings.elements.some((e) => !e.isTypeOnly && e.name.text === name);
  }
  return false;
}

/** Whether a binding name (identifier or destructuring pattern) binds `name`. */
function bindsName(ts: typeof TS, b: TS.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name;
  return b.elements.some(
    (e) => !ts.isOmittedExpression(e) && bindsName(ts, e.name, name),
  );
}
