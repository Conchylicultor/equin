import type { ParserServicesWithTypeInformation } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

/**
 * What blocks a JS thread, read off a callee's DECLARATION — never its body.
 *
 * The type-check lint cache keys a type-aware rule's result on the file and
 * the declarations it can see, not on other files' source
 * (research/2026-10-17-global-lint-keyed-on-what-it-reads.md). So "this core
 * helper calls `readFileSync` three calls down" cannot be read from the
 * helper's body at a backend's call site: an edit to that body would leave the
 * caller's cached verdict standing. The fact has to be in the declaration —
 * and node already spells it there: a blocking call is named `*Sync`.
 * `blocking-fs/sync-named` keeps that true for every helper a backend can
 * import (`core/`, `shared/`, `data-dirs/`), so the name carries the fact
 * across files and `blocking-fs/no-sync-fs` reads it.
 */

/** Plugin folders whose code runs on a long-lived backend's JS thread. */
export const BACKEND_FOLDER =
  /(?:^|\/)plugins\/[^/]+\/(?:server|machine|central|deps)\//;

/**
 * Plugin folders a backend imports whose code also serves the CLI, checks and
 * scripts — so the folder cannot say which thread runs it, and the name must.
 */
export const HELPER_FOLDER =
  /(?:^|\/)plugins\/[^/]+\/(?:core|shared|data-dirs)\//;

const FS_MODULE = /\/@types\/node\/fs\.d\.ts$/;
const CHILD_PROCESS_MODULE = /\/@types\/node\/child_process\.d\.ts$/;
const BUN_TYPES = /\/bun-types\//;
const BUN_BLOCKING = new Set(["resolveSync", "scanSync", "spawnSync"]);
/**
 * `closeSync` releases a descriptor without waiting on the disk (macOS's
 * close(2) does not flush), and `owned-fd/no-raw-fd-close` already confines it
 * to `OwnedFd.close()` — which every holder calls in a `finally`.
 */
const NOT_BLOCKING = new Set(["closeSync"]);

export type BlockingKind = "fs" | "process" | "helper";

export interface Blocking {
  /** The blocking function's declared name (`readFileSync`, `livePidSync`). */
  readonly name: string;
  readonly kind: BlockingKind;
}

/** A path relative to the repo root (`context.cwd`), or the path itself. */
export function repoRelative(file: string, cwd: string): string {
  return file.startsWith(cwd) ? file.slice(cwd.length) : file;
}

/**
 * The blocking function a declaration is, if it is one:
 *
 * - a `node:fs` `*Sync` (timed-fs's twins carry node's declaration, so an
 *   alias is one too) — `fs`;
 * - a `node:child_process` `*Sync` (`spawnSync`, `execSync`,
 *   `execFileSync`) — `process`;
 * - `Bun.resolveSync` (it stats its way up the `node_modules` chain),
 *   `Bun.Glob#scanSync`, `Bun.spawnSync`;
 * - a repo function or method named `*Sync` declared where `helpers` says
 *   (`blocking-fs/sync-named` makes the name mean it) — `helper`.
 */
export function blockingDeclaration(
  decl: ts.Declaration,
  helpers: RegExp,
): Blocking | undefined {
  const source = decl.getSourceFile().fileName;
  // A repo declaration may come from source or from its emitted `.d.ts` (the
  // type-check worker's program reads most repo files as declarations): the
  // name is the same either way, which is why the rule reads only names.
  const inRepo = !source.includes("/node_modules/");
  // The declaration's own name — or, for a member of a namespace
  // (`realpathSync.native` is `native` inside `namespace realpathSync`), the
  // nearest enclosing namespace's. Never a class's or an interface's: a method
  // of `FooSync` is not blocking for its owner's name.
  let own = declaredName(decl);
  for (
    let n: ts.Node | undefined = decl.parent;
    own?.endsWith("Sync") !== true && n !== undefined && !ts.isSourceFile(n);
    n = n.parent
  ) {
    if (ts.isModuleDeclaration(n)) own = declaredName(n);
  }
  if (own === undefined || !own.endsWith("Sync")) return undefined;
  if (NOT_BLOCKING.has(own)) return undefined;
  if (FS_MODULE.test(source)) return { name: own, kind: "fs" };
  if (CHILD_PROCESS_MODULE.test(source)) return { name: own, kind: "process" };
  if (BUN_TYPES.test(source) && BUN_BLOCKING.has(own))
    return { name: own, kind: own === "spawnSync" ? "process" : "fs" };
  if (inRepo && helpers.test(source)) return { name: own, kind: "helper" };
  return undefined;
}

function declaredName(n: ts.Node): string | undefined {
  // A function bound to a name (`const readSpecSync = () => …`,
  // `{ readSync: function () { … } }`) has none of its own: its call
  // signature's declaration is the arrow / function expression, and the name
  // the rule reads is the binding's — through any `(…)`, `as` or `satisfies`,
  // and for a function TYPE the binding it types (`const xSync: () => T`).
  if (
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionTypeNode(n)
  ) {
    if (ts.isFunctionExpression(n) && n.name !== undefined) return n.name.text;
    let p: ts.Node = n.parent;
    while (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p)
    )
      p = p.parent;
    if (
      ts.isVariableDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p)
    )
      return declaredName(p);
    return undefined;
  }
  const name = (n as ts.NamedDeclaration).name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * The property names a blocking function is reached by: every one these rules
 * report ends in `Sync`, and `realpathSync.native` hangs off one.
 */
const BLOCKING_MEMBER = /Sync$|^native$/;

/**
 * The blocking function a node reaches, if any: the callee of a call, or a
 * function passed BY REFERENCE (`paths.map(readFileSync)`,
 * `{ read: readPidSync }`) — whoever receives it calls it on this thread.
 *
 * The checker is asked the narrowest question it can answer, because what a
 * rule asks is what the checker computes and keeps for the life of the
 * program (lint `CLAUDE.md`): a call through a property not named like a
 * blocking function (`x.map(…)`, `db.select()`) is never asked about, and a
 * call is judged by its CALLEE's type — never `getResolvedSignature(call)`,
 * which checks the arguments too and so type-checked every file whole. A
 * signature's declaration survives aliasing and instantiation (timed-fs's
 * `typeof fs.readdirSync` twins, an import alias).
 */
export function blockingAt(
  node: TSESTree.CallExpression | TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  helpers: RegExp,
): Blocking | undefined {
  const checker = services.program.getTypeChecker();
  if (node.type === "CallExpression") {
    const { callee } = node;
    if (
      callee.type === "MemberExpression" &&
      (callee.computed ||
        callee.property.type !== "Identifier" ||
        !BLOCKING_MEMBER.test(callee.property.name))
    )
      return undefined;
    return blockingType(
      checker,
      services.esTreeNodeToTSNodeMap.get(callee),
      helpers,
    );
  }
  // A reference: its name already ends in `Sync` (`isSyncReference`).
  return blockingType(
    checker,
    services.esTreeNodeToTSNodeMap.get(node),
    helpers,
  );
}

/** The blocking function one of `node`'s call signatures is declared as. */
function blockingType(
  checker: ts.TypeChecker,
  node: ts.Node,
  helpers: RegExp,
): Blocking | undefined {
  // Non-nullable: `m?.readFileSync(p)` on an optional receiver.
  const type = checker.getTypeAtLocation(node).getNonNullableType();
  for (const sig of type.getCallSignatures()) {
    const decl = sig.getDeclaration() as ts.Declaration | undefined;
    if (decl === undefined || ts.isJSDocSignature(decl)) continue;
    const hit = blockingDeclaration(decl, helpers);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * A function passed by reference: an identifier or member access whose
 * name ends in `Sync`, standing as a call argument, a property value or a
 * variable's initializer. (The name filter keeps the symbol lookup off every
 * other identifier; a blocking function is named `*Sync`.)
 */
export function isSyncReference(
  node: TSESTree.Identifier | TSESTree.MemberExpression,
): boolean {
  const name =
    node.type === "Identifier"
      ? node.name
      : node.property.type === "Identifier"
        ? node.property.name
        : undefined;
  if (name === undefined || !name.endsWith("Sync")) return false;
  const parent = node.parent;
  if (parent.type === "CallExpression" || parent.type === "NewExpression")
    return parent.arguments.includes(node);
  if (parent.type === "Property")
    return parent.value === node && parent.parent.type === "ObjectExpression";
  if (parent.type === "VariableDeclarator") return parent.init === node;
  return false;
}
