import type { RuleContext } from "@typescript-eslint/utils/ts-eslint";
import type {
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import ts from "typescript";

// The provenance of a path expression, shared by `no-sync-fs` (which paths a
// sync fs call may take) and `no-unproven-claim` (which paths `asAppPath`
// may type without a declared claim): whether it is proven app-owned, and
// whether it is (built from) a user-chosen path.

/** The zod brands `AppPath` / `UserPath` carry (`string & z.$brand<…>`). */
export const APP = "AppPath";
const USER = "UserPath";

/**
 * Where a runtime file sits: the folders whose code can run on a backend's JS
 * thread. `core/` and `shared/` are imported by `server/` / `machine/` /
 * `central/`, so a sync call there runs on the same thread.
 */
const RUNTIME_FOLDER = /\/(server|machine|central|core|shared)\//;

const PATH_MODULE = /\/@types\/node\/path\.d\.ts$/;
const OS_MODULE = /\/@types\/node\/os\.d\.ts$/;
const URL_MODULE = /\/@types\/node\/url\.d\.ts$/;
export const FS_MODULE = /\/@types\/node\/fs\.d\.ts$/;
const FS_PROMISES_MODULE = /\/@types\/node\/fs\/promises\.d\.ts$/;

/**
 * The `node:path` calls whose answer stays under their FIRST argument
 * (`join(dir, name)`, `dirname(file)`): app-owned when that one is and no
 * argument is user-chosen. `resolve` is not among them — an absolute later
 * argument replaces the root — so every argument of it must be app-owned.
 */
const ROOTED_PATH_CALL = /^(join|normalize|dirname|toNamespacedPath)$/;
/** The fs calls answering a path: as app-owned as the path they read. */
const FS_PATH_ANSWER = /^realpath(Sync)?$|^readlink(Sync)?$/;
/** The fs calls minting a fresh directory under the caller's prefix. */
const FS_MINT = /^mkdtemp(Sync)?$/;
/**
 * The `node:os` directory the app may root a path in: the temp dir. Not the
 * home dir — `join(homedir(), rest)` is wherever `rest` says, Downloads
 * included; a path under home is app-owned only by a claim (`asAppPath`).
 */
const OS_DIR = /^tmpdir$/;
/**
 * `import.meta.dir` & co., `process.execPath`, `process.cwd()`: where the
 * running code and its process live.
 */
const IMPORT_META_PATH = /^(dir|dirname|path|filename)$/;

/**
 * The `*Sync` calls whose path parameters `@types/node` types as a plain
 * `string` (or `string | URL`), not `PathLike`: which argument indexes are
 * paths.
 */
export const STRING_PATH_PARAMS: Readonly<Record<string, readonly number[]>> = {
  mkdtempSync: [0],
  mkdtempDisposableSync: [0],
  cpSync: [0, 1],
  globSync: [0],
};

/** A `@types/node` parameter type that names a path (not a descriptor). */
export const PATH_PARAM_TYPE = /\bPathLike\b|\bPathOrFileDescriptor\b/;

export type Node = TSESTree.Node;

/** Whether the file linted is runtime code (matched below the repo root). */
export function inRuntime(
  context: Readonly<RuleContext<string, readonly unknown[]>>,
): boolean {
  // Matched below the repo, so a checkout under a `…/core/` dir is not all
  // runtime code.
  const file = context.filename;
  const inRepo = file.startsWith(context.cwd)
    ? file.slice(context.cwd.length)
    : file;
  return RUNTIME_FOLDER.test(inRepo);
}

/**
 * The provenance predicates over one file's typed AST — `services` read by
 * the calling rule itself (`ESLintUtils.getParserServices`), beside its
 * `requiresTypeChecking: true`.
 */
export interface Provenance {
  /** Whether a type is, or holds, the brand (every union member, for `all`). */
  branded(type: ts.Type, brand: string, all: boolean): boolean;
  typeOf(node: Node): ts.Type;
  /** The declaration a call resolves to, `undefined` for a dynamic one. */
  calleeDeclaration(
    call: TSESTree.CallExpression | TSESTree.NewExpression,
  ): ts.Declaration | undefined;
  declaredIn(decl: ts.Declaration | undefined, file: RegExp): boolean;
  /** Whether `node` is (built from) a user-chosen path. */
  user(node: Node): boolean;
  /** Whether `node` is proven app-owned. */
  app(node: Node): boolean;
}

export function provenance(
  services: ParserServicesWithTypeInformation,
): Provenance {
  const checker = services.program.getTypeChecker();
  const toTs = services.esTreeNodeToTSNodeMap;
  const toEs = services.tsNodeToESTreeNodeMap;

  /**
   * Whether a type is, or holds, the `brand`: an intersection
   * (`string & $brand<"AppPath">`), looked for through promises — and, for
   * `all`, required of every member of a union (`AppPath | undefined` is
   * app-owned where it is a string; `AppPath | string` is not).
   */
  const branded = (
    type: ts.Type,
    brand: string,
    all: boolean,
    seen = new Set<ts.Type>(),
  ): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion()) {
      const members = type.types.filter(
        (t) =>
          !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) &&
          !(t.flags & ts.TypeFlags.Never),
      );
      return members.length > 0 && all
        ? members.every((t) => branded(t, brand, all, seen))
        : members.some((t) => branded(t, brand, all, seen));
    }
    if (type.isIntersection())
      return type.types.some((part) =>
        checker
          .getPropertiesOfType(part)
          .some(
            (prop) =>
              String(prop.escapedName).startsWith("__@$brand") &&
              checker.getTypeOfSymbol(prop).getProperty(brand) !== undefined,
          ),
      );
    if (checker.isArrayType(type) || checker.isTupleType(type))
      return checker
        .getTypeArguments(type as ts.TypeReference)
        .some((t) => branded(t, brand, all, seen));
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    const awaited = checker.getAwaitedType(type);
    return (
      awaited !== undefined &&
      awaited !== type &&
      branded(awaited, brand, all, seen)
    );
  };

  const typeOf = (node: Node): ts.Type =>
    checker.getTypeAtLocation(toTs.get(node));

  /** The declaration a call resolves to, `undefined` for a dynamic one. */
  const calleeDeclaration = (
    call: TSESTree.CallExpression | TSESTree.NewExpression,
  ): ts.Declaration | undefined =>
    checker.getResolvedSignature(toTs.get(call) as ts.CallLikeExpression)
      ?.declaration;

  const declaredIn = (decl: ts.Declaration | undefined, file: RegExp) =>
    decl !== undefined && file.test(decl.getSourceFile().fileName);

  const nameOf = (decl: ts.Declaration | undefined): string =>
    (decl as ts.FunctionDeclaration | undefined)?.name?.getText() ?? "";

  /** Whether a call spreads an argument (`join(dir, ...parts)`): unprovable. */
  const spreads = (call: TSESTree.CallExpression): boolean =>
    call.arguments.some((a) => a.type === "SpreadElement");

  const args = (call: TSESTree.CallExpression): Node[] =>
    call.arguments.filter((a) => a.type !== "SpreadElement");

  /** Follow a `const` of this file to its initializer. */
  const following = new Set<Node>();
  const viaConst = (
    node: TSESTree.Identifier,
    test: (init: Node) => boolean,
  ): boolean => {
    const decl = checker.getSymbolAtLocation(toTs.get(node))?.valueDeclaration;
    if (
      decl === undefined ||
      !ts.isVariableDeclaration(decl) ||
      !ts.isIdentifier(decl.name) ||
      decl.initializer === undefined ||
      !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)
    )
      return false;
    const init = toEs.get(decl.initializer) as Node | undefined;
    if (init === undefined || following.has(init)) return false;
    following.add(init);
    try {
      return test(init);
    } finally {
      following.delete(init);
    }
  };

  /** Whether `node` is (built from) a user-chosen path. */
  const userMemo = new Map<Node, boolean>();
  const user = (node: Node): boolean => {
    let answer = userMemo.get(node);
    if (answer === undefined) {
      answer = userNow(node);
      userMemo.set(node, answer);
    }
    return answer;
  };
  const userNow = (node: Node): boolean => {
    if (branded(typeOf(node), USER, false)) return true;
    if (node.type === "TemplateLiteral") return node.expressions.some(user);
    if (node.type === "BinaryExpression")
      return node.operator === "+" && (user(node.left) || user(node.right));
    if (node.type === "ConditionalExpression")
      return user(node.consequent) || user(node.alternate);
    if (node.type === "LogicalExpression")
      return user(node.left) || user(node.right);
    if (node.type === "AwaitExpression") return user(node.argument);
    if (
      node.type === "TSNonNullExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSTypeAssertion"
    )
      return user(node.expression);
    if (node.type === "CallExpression") {
      const decl = calleeDeclaration(node);
      const derives =
        (declaredIn(decl, PATH_MODULE) &&
          !/^(basename|extname)$/.test(nameOf(decl))) ||
        ((declaredIn(decl, FS_MODULE) ||
          declaredIn(decl, FS_PROMISES_MODULE)) &&
          FS_PATH_ANSWER.test(nameOf(decl)));
      return derives && args(node).some(user);
    }
    if (node.type === "Identifier") return viaConst(node, user);
    return false;
  };

  /**
   * Whether `node`, joined under a proven root, keeps the path proven: text
   * the app's code wrote (a literal, a literal-typed or number value — an
   * enum-like union, a pid), or itself a proven path (`join` keeps an
   * absolute one under the root). A plain `string` tail — an id, a request's
   * name, a stored row's — is not: a `..` in it leaves the root. Join one
   * with `joinAppPath`, which refuses a `..` at run time.
   */
  const safeTail = (node: Node): boolean => {
    if (node.type === "Literal") return true;
    if (node.type === "TemplateLiteral")
      return node.expressions.every(safeTail);
    if (literalTyped(typeOf(node))) return true;
    return app(node);
  };

  /** A literal-typed (`"web" | "server"`, a number, `true`) value. */
  const literalTyped = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.every(literalTyped);
    if (type.flags & ts.TypeFlags.NumberLike) return true;
    if (type.flags & ts.TypeFlags.BooleanLike) return true;
    return type.isStringLiteral();
  };

  /** Whether `node` is proven app-owned. */
  const appMemo = new Map<Node, boolean>();
  const app = (node: Node): boolean => {
    let answer = appMemo.get(node);
    if (answer === undefined) {
      answer = !user(node) && appNow(node);
      appMemo.set(node, answer);
    }
    return answer;
  };
  const appNow = (node: Node): boolean => {
    if (branded(typeOf(node), APP, true)) return true;
    if (node.type === "Literal")
      return typeof node.value === "string" && node.value !== "";
    if (node.type === "TemplateLiteral") {
      // A rooted head (a literal, or a proven path), and every later part a
      // tail that keeps it there.
      const head = node.quasis[0]?.value.cooked ?? "";
      const [first, ...rest] = node.expressions;
      const rooted = head !== "" || (first !== undefined && app(first));
      const tails = head !== "" ? node.expressions : rest;
      return rooted && tails.every(safeTail);
    }
    if (node.type === "BinaryExpression")
      return (
        node.operator === "+" && app(node.left as Node) && safeTail(node.right)
      );
    if (node.type === "ConditionalExpression")
      return app(node.consequent) && app(node.alternate);
    if (node.type === "LogicalExpression")
      // `a ?? b` / `a || b` answer either; `a && b` answers b (or a falsy a,
      // which no fs call takes as a path).
      return node.operator === "&&"
        ? app(node.right)
        : app(node.left) && app(node.right);
    if (node.type === "AwaitExpression") return app(node.argument);
    if (
      node.type === "TSNonNullExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSTypeAssertion"
    )
      return app(node.expression);
    if (node.type === "MemberExpression") return appMember(node);
    if (node.type === "CallExpression") return appCall(node);
    if (node.type === "Identifier")
      return (
        node.name === "__dirname" ||
        node.name === "__filename" ||
        viaConst(node, app)
      );
    return false;
  };

  const propertyName = (node: TSESTree.MemberExpression): string =>
    node.property.type === "Identifier" && !node.computed
      ? node.property.name
      : node.property.type === "Literal"
        ? String(node.property.value)
        : "";

  const appMember = (node: TSESTree.MemberExpression): boolean => {
    const object = node.object;
    const name = propertyName(node);
    // import.meta.dir / .dirname / .path / .filename
    if (object.type === "MetaProperty") return IMPORT_META_PATH.test(name);
    // process.execPath. Not an env var: `$HOME` is no more app-owned
    // than the home dir, and the app's own variables are read (and
    // claimed) through `env-names`.
    return (
      object.type === "Identifier" &&
      object.name === "process" &&
      name === "execPath"
    );
  };

  const appCall = (node: TSESTree.CallExpression): boolean => {
    const callee = node.callee;
    if (
      callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "process" &&
      propertyName(callee) === "cwd"
    )
      return true;
    const decl = calleeDeclaration(node);
    const name = nameOf(decl);
    const all = args(node);
    // A spread hides what it holds: an absolute path among `...parts`
    // replaces `resolve`'s root, a `..` leaves `join`'s.
    if (spreads(node)) return false;
    if (declaredIn(decl, PATH_MODULE)) {
      if (ROOTED_PATH_CALL.test(name))
        return (
          all[0] !== undefined && app(all[0]) && all.slice(1).every(safeTail)
        );
      if (name === "resolve") return all.length > 0 && all.every((a) => app(a));
      return false;
    }
    if (declaredIn(decl, OS_MODULE)) return OS_DIR.test(name);
    // A module URL (`new URL("./x", import.meta.url)`) names a file of the
    // app; a user path never arrives as a file URL.
    if (declaredIn(decl, URL_MODULE)) return name === "fileURLToPath";
    if (declaredIn(decl, FS_MODULE) || declaredIn(decl, FS_PROMISES_MODULE)) {
      // A fresh dir under the prefix given — as app-owned as the prefix.
      if (FS_MINT.test(name)) return all[0] !== undefined && app(all[0]);
      if (FS_PATH_ANSWER.test(name)) return all[0] !== undefined && app(all[0]);
    }
    return false;
  };

  return {
    branded,
    typeOf,
    calleeDeclaration,
    declaredIn,
    user,
    app,
  };
}
