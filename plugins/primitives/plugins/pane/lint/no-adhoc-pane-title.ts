import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  ASTUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Pane-title typography guardrail.
 *
 * The pane title item owns the pane-title typography: it wraps the title —
 * `title.useText` string OR `title.component` — in the canonical
 * `<Text variant="label">` baseline, so any text a title component renders
 * inherits the right size by CSS inheritance (see `pane-title.tsx`). A title
 * component therefore must NOT set its own typography size; doing so
 * re-declares (when `label`) or overrides (any other variant) the container
 * baseline and reintroduces the per-pane title drift the container-enforced
 * baseline exists to close.
 *
 * Raw `text-*`/`leading-*` inside a title is already banned everywhere by
 * `text/no-adhoc-typography`. This rule closes the remaining gap: the
 * *sanctioned* typography escape — `<Text variant>` — misused INSIDE a title
 * component.
 *
 * SCOPE — deliberately conservative; ZERO false positives is the priority.
 * Mirrors `icon-auto/no-adhoc-slot-icon-size`. Fires ONLY when ALL hold:
 *
 *   1. A `Pane.define({ … })` call (matched as the member call `Pane.define`)
 *      carries `title: { component: X }` — an object literal whose
 *      `component:` value is a bare identifier.
 *   2. `X` resolves to a component declared in the SAME file: a function
 *      declaration, or a `const` initialised with an arrow / function
 *      expression. An imported component is not traced — an accepted false
 *      negative.
 *   3. The JSX that component RETURNS (its `return` arguments, or an arrow's
 *      expression body — never a nested function's) contains a `<Text>` element
 *      (matched by opening-element identifier name) carrying a `variant` prop.
 *      JSX built elsewhere (a helper component, a variable) is not followed.
 *
 * Each offending `<Text>` is reported on its own opening element. Report-only,
 * no autofix: dropping the `<Text variant>` (inherit the baseline) vs. keeping a
 * deliberate, eslint-disabled override is a human call.
 */

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFunction(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function keyIs(prop: TSESTree.Property, key: string): boolean {
  return (
    !prop.computed &&
    ((prop.key.type === "Identifier" && prop.key.name === key) ||
      (prop.key.type === "Literal" && prop.key.value === key))
  );
}

/** Is `node` (an object literal) the first argument of a `Pane.define(…)` call? */
function isPaneDefineArg(node: TSESTree.Node): boolean {
  const call = node.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments[0] === node &&
    call.callee.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.object.type === "Identifier" &&
    call.callee.object.name === "Pane" &&
    call.callee.property.type === "Identifier" &&
    call.callee.property.name === "define"
  );
}

/** The same-file function a component identifier names, or null. */
function componentFunction(
  scope: TSESLint.Scope.Scope,
  ident: TSESTree.Identifier,
): FunctionNode | null {
  const variable = ASTUtils.findVariable(scope, ident);
  const def = variable?.defs[0];
  if (!def) return null;
  if (def.node.type === "FunctionDeclaration") return def.node;
  if (
    def.node.type === "VariableDeclarator" &&
    def.node.init &&
    (def.node.init.type === "ArrowFunctionExpression" ||
      def.node.init.type === "FunctionExpression")
  ) {
    return def.node.init;
  }
  return null;
}

/** The expressions `fn` returns — not descending into nested functions. */
function returnedExpressions(fn: FunctionNode): TSESTree.Node[] {
  if (fn.body.type !== "BlockStatement") return [fn.body];
  const out: TSESTree.Node[] = [];
  const visit = (node: TSESTree.Node): void => {
    if (node !== fn && isFunction(node)) return;
    if (node.type === "ReturnStatement") {
      if (node.argument) out.push(node.argument);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) {
            visit(child as TSESTree.Node);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        visit(value as TSESTree.Node);
      }
    }
  };
  visit(fn.body);
  return out;
}

/** Recursively collect `<Text variant=…>` opening elements under `node`. */
function collectTextVariants(
  node: TSESTree.Node | null | undefined,
  out: TSESTree.JSXOpeningElement[],
): void {
  if (!node) return;
  if (node.type === "JSXOpeningElement") {
    if (node.name.type === "JSXIdentifier" && node.name.name === "Text") {
      const hasVariant = node.attributes.some(
        (a) =>
          a.type === "JSXAttribute" &&
          a.name.type === "JSXIdentifier" &&
          a.name.name === "variant",
      );
      if (hasVariant) out.push(node);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          collectTextVariants(child as TSESTree.Node, out);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      collectTextVariants(value as TSESTree.Node, out);
    }
  }
}

export default createRule({
  name: "no-adhoc-pane-title",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow <Text variant> in the JSX a pane `title.component` returns — the pane title item owns the pane-title typography baseline; a title component must inherit it, not set its own size.",
    },
    schema: [],
    messages: {
      adhocPaneTitle:
        "<Text variant> in a pane `title.component` overrides the pane-title " +
        "typography baseline the pane title item provides. Remove it and let the " +
        "title inherit the canonical size; set a different size only as a deliberate " +
        "override via `// eslint-disable-next-line pane/no-adhoc-pane-title -- reason`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const checked = new Set<FunctionNode>();
    return {
      Property(node) {
        // 1. `component: X` inside `title: { … }` of a `Pane.define({ … })`.
        if (!keyIs(node, "component")) return;
        if (node.value.type !== "Identifier") return;
        const titleObject = node.parent;
        if (titleObject.type !== "ObjectExpression") return;
        const titleProp = titleObject.parent;
        if (
          titleProp.type !== "Property" ||
          titleProp.value !== titleObject ||
          !keyIs(titleProp, "title")
        ) {
          return;
        }
        if (!isPaneDefineArg(titleProp.parent)) return;

        // 2. The component, declared in this file.
        const fn = componentFunction(
          context.sourceCode.getScope(node),
          node.value,
        );
        if (!fn || checked.has(fn)) return;
        checked.add(fn);

        // 3. Flag every `<Text variant>` in the JSX it returns.
        const offenders: TSESTree.JSXOpeningElement[] = [];
        for (const expr of returnedExpressions(fn)) {
          collectTextVariants(expr, offenders);
        }
        for (const el of offenders) {
          context.report({ node: el, messageId: "adhocPaneTitle" });
        }
      },
    };
  },
});
