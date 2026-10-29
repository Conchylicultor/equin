/**
 * Bans building a `LinkTarget` and throwing it away.
 *
 * A `LinkTarget` (`openPane.to(…)`, tabs' `appLink(url)`, an opener's
 * `useTarget()`, `ExplorerNavigator.to(…)`) is a destination as DATA — it does
 * not navigate. Built and dropped, it does nothing, with no error anywhere:
 *
 * ```tsx
 * openTrash={() => openPane.to(trashPane, {}, { mode: "push" })}   // ✗ dead button
 * onClick={() => appLink(url)}                                      // ✗
 * openPane.to(p, { id }, { mode: "push" });                         // ✗ statement
 * const go = () => openPane.to(p, {}, opts); <X onOpen={go} />      // ✗ (onOpen: () => void)
 *
 * <Button {...openPane.link(p, { id }, { mode: "push" })} />        // ✓ a link
 * <Row activation={openPane.to(p, { id }, { mode: "push" })} />     // ✓ handed over
 * onSelect={() => openPane(p, { id }, { mode: "push" })}            // ✓ an imperative open
 * ```
 *
 * TypeScript cannot see this: a function returning a value is assignable to a
 * `() => void` type (its return is ignored), and there is no must-use return.
 * `Activation`'s function arm (`() => void | undefined`) makes it a tsc error
 * on activation props — this rule covers every OTHER void context (React's DOM
 * handlers, a component's own `() => void` props, `forEach`, a named handler)
 * and the bare statement.
 *
 * Keyed on the TYPE, not on names: a *link-like* value is one any of whose
 * union members has callable `open` and `href` properties — whatever built it
 * and whatever the receiving prop is called (the bug that motivated this rule
 * was a custom `openTrash` prop). It reports:
 *
 * - `statement` — an expression statement (assignments aside, `void x`
 *   included) whose value is link-like.
 * - `voidReturn` — a function literal with no return-type annotation that
 *   returns a link-like value (arrow expression body, or a `return`) where its
 *   contextual type's call signature returns exactly `void`.
 * - `voidCallback` — a function VALUE (not a literal) returning a link-like
 *   value, given as a JSX attribute, call argument or object property whose
 *   contextual type is a function returning exactly `void`.
 *
 * Exactly `void` only: a union return (`void | undefined`, `void | Promise<…>`)
 * is already type-checked by tsc, which rejects a `LinkTarget` there.
 *
 * Closed: there is no legitimate discarded link.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = lintRuleCreator(import.meta.url);

const FIX =
  "Spread `openPane.link(…)` (or `activationProps(target)`) on the control, pass the target as its `activation`, or — for an open with no gesture to read — call `openPane(…)` itself.";

type FunctionLiteral =
  TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

export default createRule({
  name: "no-discarded-link",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow building a LinkTarget (openPane.to, appLink, an opener's target) and discarding it — as a statement or as the return of a void callback — which silently does nothing.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      statement: `This builds a LinkTarget and discards it: a LinkTarget is data, it does not navigate. ${FIX}`,
      voidReturn: `This callback returns a LinkTarget where its return is ignored (\`() => void\`), so it does nothing. ${FIX}`,
      voidCallback: `This function returns a LinkTarget but is passed where the return is ignored (\`() => void\`), so it does nothing. ${FIX}`,
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const toTs = (node: TSESTree.Node): ts.Node =>
      services.esTreeNodeToTSNodeMap.get(node);

    const isCallableProp = (type: ts.Type, name: string, at: ts.Node) => {
      const prop = type.getProperty(name);
      if (!prop) return false;
      return (
        checker.getTypeOfSymbolAtLocation(prop, at).getCallSignatures().length >
        0
      );
    };

    /** Any union member carries callable `open` and `href`. */
    const isLinkLike = (type: ts.Type, at: ts.Node): boolean => {
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
      const parts = type.isUnion() ? type.types : [type];
      return parts.some(
        (part) =>
          isCallableProp(part, "open", at) && isCallableProp(part, "href", at),
      );
    };

    const isLinkLikeNode = (node: TSESTree.Node): boolean => {
      const tsNode = toTs(node);
      return isLinkLike(checker.getTypeAtLocation(tsNode), tsNode);
    };

    const isExactlyVoid = (type: ts.Type) =>
      (type.flags & ts.TypeFlags.Void) !== 0;

    /** The contextual type of `expr` is a function whose return is ignored. */
    const expectsVoidCallback = (expr: TSESTree.Node): boolean => {
      const tsNode = toTs(expr);
      if (!ts.isExpression(tsNode)) return false;
      const contextual = checker.getContextualType(tsNode);
      if (!contextual) return false;
      const parts = contextual.isUnion() ? contextual.types : [contextual];
      const signatures = parts.flatMap((p) => p.getCallSignatures());
      return (
        signatures.length > 0 &&
        signatures.every((s) => isExactlyVoid(s.getReturnType()))
      );
    };

    const checkReturned = (fn: FunctionLiteral, value: TSESTree.Node) => {
      if (fn.returnType) return; // tsc checks an annotated return
      if (!isLinkLikeNode(value)) return;
      if (!expectsVoidCallback(fn)) return;
      context.report({ node: value, messageId: "voidReturn" });
    };

    const enclosingFunction = (
      node: TSESTree.Node,
    ): TSESTree.Node | undefined => {
      for (let n = node.parent; n; n = n.parent) {
        if (
          n.type === "ArrowFunctionExpression" ||
          n.type === "FunctionExpression" ||
          n.type === "FunctionDeclaration"
        ) {
          return n;
        }
      }
      return undefined;
    };

    /** A function VALUE (not a literal) whose calls return a link. */
    const checkCallbackValue = (expr: TSESTree.Node) => {
      if (
        expr.type === "ArrowFunctionExpression" ||
        expr.type === "FunctionExpression" ||
        expr.type === "JSXEmptyExpression"
      ) {
        return;
      }
      const tsNode = toTs(expr);
      const type = checker.getTypeAtLocation(tsNode);
      const returnsLink = type
        .getCallSignatures()
        .some((s) => isLinkLike(s.getReturnType(), tsNode));
      if (!returnsLink) return;
      if (!expectsVoidCallback(expr)) return;
      context.report({ node: expr, messageId: "voidCallback" });
    };

    return {
      ExpressionStatement(node) {
        const expr = node.expression;
        if (expr.type === "AssignmentExpression") return;
        const value =
          expr.type === "UnaryExpression" && expr.operator === "void"
            ? expr.argument
            : expr;
        if (isLinkLikeNode(value)) {
          context.report({ node, messageId: "statement" });
        }
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== "BlockStatement") checkReturned(node, node.body);
      },
      ReturnStatement(node) {
        if (!node.argument) return;
        const fn = enclosingFunction(node);
        if (
          fn?.type === "ArrowFunctionExpression" ||
          fn?.type === "FunctionExpression"
        ) {
          checkReturned(fn, node.argument);
        }
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === "JSXAttribute") {
          checkCallbackValue(node.expression);
        }
      },
      CallExpression(node) {
        for (const arg of node.arguments) checkCallbackValue(arg);
      },
      Property(node) {
        if (node.parent.type === "ObjectExpression") {
          checkCallbackValue(node.value);
        }
      },
    };
  },
});
