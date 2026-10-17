import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type { Node as TsNode, Type as TsType, TypeChecker } from "typescript";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * The shared `Button` primitive
 * (`@plugins/primitives/plugins/css/plugins/ui-kit/web`) auto-pends: when its
 * `onClick` returns a promise it shows a spinner and disables itself until the
 * promise settles — a built-in double-click guard. `IconButton`
 * (`@plugins/primitives/plugins/icon-button/web`) composes `Button` and inherits
 * this behavior.
 *
 * Raw `<button>` elements and the shadcn `SidebarMenuAction` component do NOT
 * compose `Button`, so an async / promise-returning `onClick` on them silently
 * loses the spinner + double-click guard. This rule flags that whole class and
 * steers contributors to `Button`/`IconButton`.
 */
const TARGET_TAGS = new Set(["button", "SidebarMenuAction"]);

/**
 * Returns true when `type` (or any member of a union like `void | Promise<void>`)
 * is thenable — i.e. has a callable `then` member.
 */
function isThenableType(
  checker: TypeChecker,
  type: TsType,
  atNode: TsNode,
): boolean {
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    const then = part.getProperty("then");
    if (!then) continue;
    const thenType = checker.getTypeOfSymbolAtLocation(then, atNode);
    if (thenType.getCallSignatures().length > 0) return true;
  }
  return false;
}

export default createRule({
  name: "no-async-raw-button",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow async / promise-returning onClick on raw <button> or SidebarMenuAction — they cannot auto-pend; use Button/IconButton which show a spinner and guard against double-clicks while the promise is in flight.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      asyncOnRawButton:
        "`onClick` on a raw <{{tag}}> {{detail}}. Raw <button>/SidebarMenuAction cannot reflect in-flight state, so the spinner + double-click guard are silently lost. Use `Button` or `IconButton` from @plugins/primitives/plugins/css/plugins/ui-kit/web (or @plugins/primitives/plugins/icon-button/web) — they auto-pend while the returned promise is in flight. For genuine fire-and-forget, still use a Button (it won't pend if you don't return the promise).",
    },
  },
  defaultOptions: [],
  create(context) {
    // Every .ts/.tsx in this repo resolves to type info (the type-check worker
    // supplies a pre-built program; the IDE uses projectService), so the
    // services are always type-aware here.
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const nodeMap = services.esTreeNodeToTSNodeMap;

    return {
      JSXAttribute(node: TSESTree.JSXAttribute) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "onClick")
          return;

        const tag = node.parent.name;
        if (tag.type !== "JSXIdentifier" || !TARGET_TAGS.has(tag.name)) return;

        const value = node.value;
        if (!value || value.type !== "JSXExpressionContainer") return;
        const handler = value.expression;
        if (handler.type === "JSXEmptyExpression") return;

        const report = (detail: string) => {
          context.report({
            node,
            messageId: "asyncOnRawButton",
            data: { tag: tag.name, detail },
          });
        };

        // (A) SYNTACTIC — async arrow / function expression.
        if (
          (handler.type === "ArrowFunctionExpression" ||
            handler.type === "FunctionExpression") &&
          handler.async === true
        ) {
          report("is an async function");
          return;
        }

        // Type-aware checks (catch async refs + void-swallowed promises).

        const typeOf = (expr: TSESTree.Expression): TsType | undefined => {
          const tsNode = nodeMap.get(expr);
          if (!tsNode) return undefined;
          return checker.getTypeAtLocation(tsNode);
        };

        const isThenableExpr = (expr: TSESTree.Expression): boolean => {
          const tsNode = nodeMap.get(expr);
          if (!tsNode) return false;
          const type = checker.getTypeAtLocation(tsNode);
          return isThenableType(checker, type, tsNode);
        };

        // (B) TYPE-AWARE — handler's type is a function returning a thenable.
        const handlerType = typeOf(handler);
        if (handlerType) {
          const handlerTsNode = nodeMap.get(handler);
          if (handlerTsNode) {
            for (const sig of handlerType.getCallSignatures()) {
              if (
                isThenableType(checker, sig.getReturnType(), handlerTsNode)
              ) {
                report("returns a promise");
                return;
              }
            }
          }
        }

        // (C) TYPE-AWARE void-swallow — `() => void asyncFn()` or
        // `() => { void asyncFn(); }`.
        if (handler.type === "ArrowFunctionExpression") {
          const body = handler.body;
          if (
            body.type === "UnaryExpression" &&
            body.operator === "void" &&
            isThenableExpr(body.argument)
          ) {
            report("void-swallows a promise");
            return;
          }
          if (body.type === "BlockStatement") {
            for (const stmt of body.body) {
              if (
                stmt.type === "ExpressionStatement" &&
                stmt.expression.type === "UnaryExpression" &&
                stmt.expression.operator === "void" &&
                isThenableExpr(stmt.expression.argument)
              ) {
                report("void-swallows a promise");
                return;
              }
            }
          }
        }
      },
    };
  },
});
