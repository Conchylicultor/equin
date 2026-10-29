import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ASTUtils, type TSESTree } from "@typescript-eslint/utils";
import type { Scope } from "@typescript-eslint/utils/ts-eslint";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A React context Provider's `value` is compared by identity (`Object.is`):
 * every `useContext` consumer re-renders whenever that identity changes. When
 * the `value` is an object / array / function constructed *during render* — be
 * it inline (`value={{ ... }}`) or via a local `const v = { ... }` passed as
 * `value={v}` — a brand new reference is produced on every provider render, so
 * all consumers re-render even when the underlying data is unchanged. That is
 * silent re-render debt and a correctness smell (consumers can't rely on
 * referential stability).
 *
 * Primitives (`value={true}`, `value={mode}`, `value={`${a}`}`) are compared by
 * value, so a recomputed primitive with the same content does NOT re-render
 * consumers — those are fine. Only reference-typed render-time constructions are
 * the hazard, so this rule flags exactly: object/array literals, arrow/function
 * expressions, and `new` expressions.
 *
 * The fix is always to give the value a stable identity: wrap the object in
 * `useMemo`, the inline functions in `useCallback` (or hoist stable setters),
 * then pass the memoized variable as `value`.
 *
 * Two value forms are caught:
 *  - Inline:   `<Ctx.Provider value={{ ... }}>` — the JSX expression is itself
 *    a constructed value.
 *  - Indirect: `const v = { ... }; <Ctx.Provider value={v}>` — the identifier
 *    resolves to a single render-scoped declaration whose initializer is a
 *    constructed value. Module-level constants (created once) are NOT flagged;
 *    only declarations inside a function (re-created each render) are.
 *
 * Call expressions are intentionally NOT flagged: `value={useMemo(...)}` and
 * `const v = useStore(); value={v}` are stable by contract and indistinguishable
 * from an unstable `value={makeThing()}` without type info — flagging them would
 * create false positives on the correct pattern.
 *
 * A "Provider" is detected structurally — either a `Foo.Provider` member
 * expression, or a bare element whose name ends in `Provider`/`Context` (the
 * React-19 `<SomeContext value={...}>` form and provider-wrapper components).
 */

/** True for the `Foo.Provider` JSX member-expression form. */
function isProviderMember(name: TSESTree.JSXTagNameExpression): boolean {
  return (
    name.type === "JSXMemberExpression" &&
    name.property.type === "JSXIdentifier" &&
    name.property.name === "Provider"
  );
}

/** True for a bare `<SomeContext>` / `<SomeProvider>` element name. */
function isProviderIdentifier(name: TSESTree.JSXTagNameExpression): boolean {
  return (
    name.type === "JSXIdentifier" &&
    (name.name.endsWith("Provider") || name.name.endsWith("Context"))
  );
}

const UNSTABLE_TYPES = new Set<string>([
  "ObjectExpression",
  "ArrayExpression",
  "ArrowFunctionExpression",
  "FunctionExpression",
  "NewExpression",
]);

function kindOf(type: string): string {
  switch (type) {
    case "ObjectExpression":
      return "object";
    case "ArrayExpression":
      return "array";
    case "NewExpression":
      return "object (new expression)";
    default:
      return "function";
  }
}

/** True when `scope` is, or is nested within, a function — i.e. render-scoped. */
function isRenderScoped(scope: Scope.Scope | null): boolean {
  for (let s = scope; s; s = s.upper) {
    if (s.type === "function") return true;
  }
  return false;
}

export default createRule({
  name: "no-unstable-context-value",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a render-constructed object/array/function as a context Provider `value` — it gets a fresh identity every render, forcing all useContext consumers to re-render even when the data is unchanged. Give it a stable identity (useMemo / useCallback / hoisted setters).",
    },
    schema: [],
    messages: {
      unstableContextValue:
        "Context Provider `value` is a render-constructed {{kind}}, so it gets a new identity on every render and re-renders all useContext consumers even when nothing changed. Give it a stable identity: wrap the object in `useMemo` (and inline functions in `useCallback`, or hoist stable setters), then pass the memoized variable as `value`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node: TSESTree.JSXAttribute) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "value")
          return;

        const tag = node.parent.name;
        if (!isProviderMember(tag) && !isProviderIdentifier(tag)) return;

        const value = node.value;
        if (!value || value.type !== "JSXExpressionContainer") return;
        const expr = value.expression;

        // (A) Inline construction: `value={{ ... }}`, `value={[...]}`, etc.
        if (UNSTABLE_TYPES.has(expr.type)) {
          context.report({
            node,
            messageId: "unstableContextValue",
            data: { kind: kindOf(expr.type) },
          });
          return;
        }

        // (B) Indirect: `const v = { ... }; value={v}` where `v` resolves to a
        // single render-scoped declaration with a constructed initializer.
        if (expr.type !== "Identifier") return;
        const variable = ASTUtils.findVariable(
          context.sourceCode.getScope(expr),
          expr,
        );
        if (!variable || variable.defs.length !== 1) return;
        const def = variable.defs[0];
        if (
          !def ||
          def.type !== "Variable" ||
          def.node.type !== "VariableDeclarator" ||
          !def.node.init
        )
          return;
        const init = def.node.init;
        if (!UNSTABLE_TYPES.has(init.type)) return;
        if (!isRenderScoped(variable.scope)) return;

        context.report({
          node,
          messageId: "unstableContextValue",
          data: { kind: kindOf(init.type) },
        });
      },
    };
  },
});
