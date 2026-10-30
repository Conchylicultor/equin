import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = lintRuleCreator(import.meta.url);

/** The zod brand `UserPath` carries (`string & z.$brand<"UserPath">`). */
const BRAND = "UserPath";

/** Where a runtime file sits: the folders whose code runs in a backend. */
const BACKEND_FOLDER = /\/(server|machine|central)\//;

/**
 * The `@types/node` calls that DERIVE a path from their argument
 * (`join(dir, name)`, `await realpath(dir)`) rather than consume it: their
 * answer is as user-chosen as the argument was. Every `node:path` function,
 * but `basename` / `extname` (a name, not a path), and the fs calls answering
 * a path.
 */
const PATH_MODULE = /\/@types\/node\/path\.d\.ts$/;
/** The `node:path` answers that name an entry, not a path to one. */
const NOT_A_PATH = /^(basename|extname)$/;
const FS_PATH_ANSWER = /^realpath(Sync)?$|^readlink(Sync)?$/;
const FS_MODULE = /\/@types\/node\/fs\.d\.ts$/;
const FS_PROMISES_MODULE = /\/@types\/node\/fs\/promises\.d\.ts$/;

type Node = TSESTree.Node;

/**
 * no-sync-fs
 *
 * A path the user (or their config) chose — a `UserPath` — never reaches a
 * synchronous fs call. Such a path may sit in a folder macOS gates behind
 * Files & Folders (Downloads, Documents, Desktop, removable and network
 * volumes); while the "allow access?" prompt is up, a `realpathSync` /
 * `readdirSync` / `statSync` / `opendirSync` / … on it blocks the backend's
 * whole JS thread until someone answers. On 2026-10-11 one `realpathSync` of
 * `~/Downloads` froze main for 5.5 h
 * (research/2026-10-30-apps-sonata-midi-folder-probe-off-the-js-thread.md).
 *
 * Taint is carried by the TYPE, so it crosses files without this rule reading
 * any file but the one it lints (a type-aware rule may read declarations
 * only — research/2026-10-17-global-lint-keyed-on-what-it-reads.md). An
 * expression is user-chosen when:
 *
 * - its type carries the `UserPath` brand (a `dirPathField` value, a host-fs
 *   request path, a parameter declared `UserPath`), or
 * - it is derived from one: `join` / `resolve` / … of `node:path`, an async
 *   fs answer (`await realpath(p)`), a template literal, a `+`, a conditional
 *   or logical branch, an `await`, a cast — or a `const` bound to such an
 *   expression in this file.
 *
 * Reported:
 *
 * - **sync** — a user-chosen argument to a `node:fs` `*Sync` function,
 *   anywhere.
 * - **widened** — in backend code (`server/`, `machine/`, `central/`), a
 *   user-chosen value handed to a place typed as a plain `string`: a
 *   parameter of a backend function, a return, an annotated binding or an
 *   assignment to one. That is where the brand would be lost and the next
 *   function could not be checked — declare the receiving place `UserPath`
 *   instead (or `asUserPath(…)` a derived path), so the check follows the
 *   path. Handing it to a library (`node:path`, a logger, …) is not widening,
 *   and neither is a field of an object: a result or wire shape carries a
 *   path out of the backend, not into another fs call.
 */
export default createRule({
  name: "no-sync-fs",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a synchronous fs call on a user-chosen path (UserPath): a pending macOS Files & Folders prompt blocks it — and the backend's JS thread — until someone answers.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      sync: "`{{name}}` on a user-chosen path blocks the backend's JS thread while macOS asks whether equin may open its folder (5.5 h on 2026-10-11). Use the async `node:fs/promises` call, bounded so a caller never waits on the prompt: a probe still unanswered after a bound reads as a `checking` state (Sonata's midi folders: `createFolderStatusStore`), and host-fs is the async read API.",
      widened:
        "A user-chosen path (UserPath) is handed to a place typed as a plain `string`, which drops the brand that keeps synchronous fs calls off it. Declare the receiving parameter / return / property `UserPath` (`@plugins/infra/plugins/host-fs/plugins/user-path/core`), or wrap a derived path in `asUserPath(…)`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const toTs = services.esTreeNodeToTSNodeMap;
    const toEs = services.tsNodeToESTreeNodeMap;
    const backend = BACKEND_FOLDER.test(context.filename);

    /**
     * Whether a type is, or holds, a `UserPath`: the brand is an intersection
     * (`string & $brand<"UserPath">`), looked for through unions, arrays,
     * tuples and promises — once per type, so a recursive type ends.
     */
    const isBranded = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
      if (seen.has(type)) return false;
      seen.add(type);
      if (type.isUnion()) return type.types.some((t) => isBranded(t, seen));
      if (type.isIntersection())
        return type.types.some((part) =>
          checker
            .getPropertiesOfType(part)
            .some(
              (prop) =>
                String(prop.escapedName).startsWith("__@$brand") &&
                checker.getTypeOfSymbol(prop).getProperty(BRAND) !== undefined,
            ),
        );
      if (checker.isArrayType(type) || checker.isTupleType(type))
        return checker
          .getTypeArguments(type as ts.TypeReference)
          .some((t) => isBranded(t, seen));
      if (!(type.flags & ts.TypeFlags.Object)) return false;
      const awaited = checker.getAwaitedType(type);
      return (
        awaited !== undefined && awaited !== type && isBranded(awaited, seen)
      );
    };

    const isStringLike = (type: ts.Type): boolean => {
      if (type.isUnion()) return type.types.some(isStringLike);
      if (type.flags & ts.TypeFlags.StringLike) return true;
      if (checker.isArrayType(type))
        return checker
          .getTypeArguments(type as ts.TypeReference)
          .some(isStringLike);
      return false;
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

    const isLibrary = (decl: ts.Declaration | undefined): boolean =>
      decl === undefined ||
      decl.getSourceFile().fileName.includes("/node_modules/") ||
      services.program.isSourceFileDefaultLibrary(decl.getSourceFile());

    const nameOf = (decl: ts.Declaration | undefined): string =>
      (decl as ts.FunctionDeclaration | undefined)?.name?.getText() ?? "";

    const derives = (decl: ts.Declaration | undefined): boolean => {
      if (declaredIn(decl, PATH_MODULE)) return !NOT_A_PATH.test(nameOf(decl));
      if (!declaredIn(decl, FS_MODULE) && !declaredIn(decl, FS_PROMISES_MODULE))
        return false;
      return FS_PATH_ANSWER.test(nameOf(decl));
    };

    const following = new Set<Node>();
    /** A `const` of this file bound to a user-chosen expression. */
    const taintedConst = (
      node: TSESTree.Identifier,
      text: boolean,
    ): boolean => {
      const decl = checker.getSymbolAtLocation(
        toTs.get(node),
      )?.valueDeclaration;
      if (
        decl === undefined ||
        !ts.isVariableDeclaration(decl) ||
        decl.initializer === undefined ||
        !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)
      )
        return false;
      const init = toEs.get(decl.initializer) as Node | undefined;
      if (init === undefined || following.has(init)) return false;
      following.add(init);
      try {
        return tainted(init, text);
      } finally {
        following.delete(init);
      }
    };

    /**
     * Whether `node` is user-chosen. `text`: also through a template literal
     * or a `+` — for a sync call's argument, where such a string is a path
     * (`${dir}/x`); not for widening, where it is as often a key or a message.
     */
    const memo = [new Map<Node, boolean>(), new Map<Node, boolean>()];
    const tainted = (node: Node, text: boolean): boolean => {
      const seen = memo[Number(text)]!;
      let answer = seen.get(node);
      if (answer === undefined) {
        answer = taintedNow(node, text);
        seen.set(node, answer);
      }
      return answer;
    };
    const taintedNow = (node: Node, text: boolean): boolean => {
      const t = (n: Node) => tainted(n, text);
      if (isBranded(typeOf(node))) return true;
      if (node.type === "TemplateLiteral")
        return text && node.expressions.some(t);
      if (node.type === "BinaryExpression")
        return text && node.operator === "+" && (t(node.left) || t(node.right));
      if (node.type === "ConditionalExpression")
        return t(node.consequent) || t(node.alternate);
      if (node.type === "LogicalExpression")
        return t(node.left) || t(node.right);
      if (node.type === "AwaitExpression") return t(node.argument);
      if (
        node.type === "TSNonNullExpression" ||
        node.type === "TSAsExpression" ||
        node.type === "TSSatisfiesExpression" ||
        node.type === "TSTypeAssertion"
      )
        return t(node.expression);
      if (node.type === "CallExpression")
        return (
          derives(calleeDeclaration(node)) &&
          node.arguments.some((a) => a.type !== "SpreadElement" && t(a))
        );
      if (node.type === "Identifier") return taintedConst(node, text);
      return false;
    };

    /** The `node:fs` `*Sync` function a call invokes, if it does. */
    const syncFsName = (call: TSESTree.CallExpression): string | undefined => {
      const decl = calleeDeclaration(call);
      if (decl === undefined || !declaredIn(decl, FS_MODULE)) return undefined;
      // The function itself, or the namespace it hangs off:
      // `realpathSync.native` is `native` inside `namespace realpathSync`.
      for (let n: ts.Node | undefined = decl; n !== undefined; n = n.parent) {
        const name = (n as ts.FunctionDeclaration).name?.getText();
        if (name?.endsWith("Sync") === true) return name;
        if (ts.isSourceFile(n)) break;
      }
      return undefined;
    };

    /** Whether the brand is dropped where `node` is handed to its parent. */
    const widened = (node: Node): boolean => {
      const parent = node.parent;
      if (parent === undefined) return false;
      if (
        (parent.type === "CallExpression" || parent.type === "NewExpression") &&
        parent.arguments.includes(node as TSESTree.CallExpressionArgument)
      ) {
        // A library consumes or derives; a backend function must take
        // UserPath.
        // Only a backend function can go on to touch the disk: a `core/` or
        // `shared/` one cannot import `node:fs` (`boundaries/no-platform-api`).
        const callee = calleeDeclaration(parent);
        if (!declaredIn(callee, BACKEND_FOLDER) || isLibrary(callee))
          return false;
      } else if (!(
        parent.type === "ReturnStatement" ||
        (parent.type === "ArrowFunctionExpression" && parent.body === node) ||
        (parent.type === "VariableDeclarator" && parent.id.typeAnnotation) ||
        (parent.type === "AssignmentExpression" && parent.right === node)
      )) {
        return false;
      }
      const expected = checker.getContextualType(
        toTs.get(node) as ts.Expression,
      );
      return (
        expected !== undefined && isStringLike(expected) && !isBranded(expected)
      );
    };

    const reported = new Set<Node>();
    const visit = (node: Node) => {
      if (reported.has(node)) return;
      const parent = node.parent;
      const name =
        parent?.type === "CallExpression" &&
        parent.arguments.includes(node as TSESTree.CallExpressionArgument)
          ? syncFsName(parent)
          : undefined;
      if (name !== undefined) {
        if (!tainted(node, true)) return;
        reported.add(node);
        context.report({ node, messageId: "sync", data: { name } });
        return;
      }
      if (backend && tainted(node, false) && widened(node)) {
        reported.add(node);
        context.report({ node, messageId: "widened" });
      }
    };

    return {
      Identifier(node) {
        // A name, not a value: a key, a member's property, a declaration.
        const p = node.parent;
        if (
          (p.type === "MemberExpression" && p.property === node) ||
          (p.type === "Property" && p.key === node && !p.shorthand) ||
          (p.type === "VariableDeclarator" && p.id === node) ||
          (p.type.startsWith("TS") && !p.type.endsWith("Expression")) ||
          (p.type === "AssignmentExpression" && p.left === node) ||
          p.type.endsWith("Declaration") ||
          ((p.type === "FunctionExpression" ||
            p.type === "ArrowFunctionExpression") &&
            p.params.includes(node)) ||
          p.type.startsWith("Import") ||
          p.type.startsWith("Export") ||
          p.type === "LabeledStatement"
        )
          return;
        visit(node);
      },
      MemberExpression: visit,
      CallExpression: visit,
      AwaitExpression: visit,
      TemplateLiteral(node) {
        if (node.parent.type !== "TaggedTemplateExpression") visit(node);
      },
      'BinaryExpression[operator="+"]': visit,
      ConditionalExpression: visit,
      LogicalExpression: visit,
      TSAsExpression: visit,
      TSSatisfiesExpression: visit,
      TSTypeAssertion: visit,
      TSNonNullExpression: visit,
    };
  },
});
