import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";
import { APP, inRuntime, provenance } from "./provenance";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-unproven-claim
 *
 * `asAppPath(x)` (or `x as AppPath`) types a path app-owned — the proof a
 * synchronous fs call needs (`no-sync-fs`). When the rule can prove `x`
 * app-owned itself (a temp dir, `realpath` / `dirname` / a `${p}.tmp` of an
 * `AppPath`, a literal, `import.meta.dir`…) the call only gives tsc the type.
 * Anything else is a CLAIM the code cannot back — a home-relative path, an env
 * var, a value read from a record — so it is reported: a claim is made only
 * by a file that declares it, as a `sanctioned` exemption of this rule in its
 * plugin's `exempt/index.ts` with the reason the path is the app's. That keeps
 * every claim listed in one place (`./equin exempt list --rule
 * user-path/no-unproven-claim`) instead of scattered where a type was
 * inconvenient, which is how an allow-list turns into a rubber stamp.
 *
 * A user-chosen path (`UserPath`) is never claimable (**launder**), exempt or
 * not: a sync fs call on it would freeze the backend on a macOS permission
 * prompt.
 */
export default createRule({
  name: "no-unproven-claim",
  meta: {
    type: "problem",
    docs: {
      description:
        "asAppPath / `as AppPath` of a path the rule cannot prove app-owned is a claim: declare it as a sanctioned exemption (with its reason) in the claiming plugin, or derive the path from an AppPath source.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      claim:
        "Typing this path `AppPath` claims the app owns it, and nothing here proves it (not a data dir, a path under one, the checkout, a temp dir…). Derive it from an `AppPath` source — a parameter / field / return typed `AppPath`, `joinAppPath` — or, where the app really makes it here (an env var it sets, a fixed path under home), declare the claim: a `sanctioned` exemption of `user-path/no-unproven-claim` for this file in its plugin's `exempt/index.ts`, with the reason.",
      launder:
        "A user-chosen path (UserPath) cannot become an AppPath: a sync fs call on it would block the backend's JS thread on a macOS permission prompt. Keep it a UserPath and read it with the async API.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!inRuntime(context)) return {};
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const toTs = services.esTreeNodeToTSNodeMap;
    const { branded, typeOf, user, app } = provenance(services);

    const check = (node: TSESTree.Node, value: TSESTree.Node) => {
      if (user(value)) context.report({ node, messageId: "launder" });
      else if (!app(value)) context.report({ node, messageId: "claim" });
    };

    /**
     * Whether `node` names `asAppPath`, whatever it is bound to here (an
     * aliased import included): resolved to its declaration's own name.
     */
    const isAsAppPath = (node: TSESTree.Node): boolean => {
      if (node.type !== "Identifier") return false;
      let symbol = checker.getSymbolAtLocation(toTs.get(node));
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      const decl = symbol?.valueDeclaration;
      return (
        decl !== undefined &&
        ts.isFunctionDeclaration(decl) &&
        decl.name?.text === "asAppPath"
      );
    };

    /** A cast to `AppPath` (`x as AppPath`, `<AppPath>x`) — the outer one. */
    const checkCast = (
      node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion,
    ) => {
      if (
        node.parent.type === "TSAsExpression" ||
        node.parent.type === "TSTypeAssertion"
      )
        return;
      if (!branded(typeOf(node), APP, true)) return;
      let inner: TSESTree.Node = node.expression;
      while (
        inner.type === "TSAsExpression" ||
        inner.type === "TSTypeAssertion"
      )
        inner = inner.expression;
      if (!branded(typeOf(inner), APP, true)) check(node, inner);
    };

    return {
      CallExpression(node) {
        if (!isAsAppPath(node.callee)) return;
        const arg = node.arguments[0];
        if (arg !== undefined && arg.type !== "SpreadElement") check(node, arg);
      },
      Identifier(node) {
        // `asAppPath` handed on as a value (`.map(asAppPath)`,
        // `.transform(asAppPath)`, `const f = asAppPath`): every value it
        // will see is unproven.
        const parent = node.parent;
        const handedOn =
          ((parent.type === "CallExpression" ||
            parent.type === "NewExpression") &&
            parent.arguments.includes(node)) ||
          (parent.type === "VariableDeclarator" && parent.init === node) ||
          (parent.type === "Property" && parent.value === node) ||
          parent.type === "ArrayExpression" ||
          parent.type === "ReturnStatement" ||
          (parent.type === "AssignmentExpression" && parent.right === node);
        if (handedOn && isAsAppPath(node))
          context.report({ node, messageId: "claim" });
      },
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,
    };
  },
});
