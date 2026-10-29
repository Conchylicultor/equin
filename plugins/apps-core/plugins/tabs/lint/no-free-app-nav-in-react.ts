/**
 * Bans the free cross-app navigation — the tabs barrel's `navigate`,
 * `appLink` and `appLinkProps` — inside a React component or hook.
 *
 * The free forms drive the host's tab set directly. A component can render
 * inside an `AppNavBoundary` (an in-process `<AppEmbed>`, e.g. the agent
 * manager demo), whose navigator must decide where its links go; the free
 * forms skip it, so a click inside the embed swaps the host page's tab. The
 * hook forms read the boundary and fall back to the free function outside
 * one, so they are the same behavior everywhere else:
 *
 * ```tsx
 * function Chip({ url }) {
 *   return <Row {...appLinkProps(url)} />;              // ✗
 * }
 * function Chip({ url }) {
 *   const appLinkProps = useAppLinkProps();             // ✓
 *   return <Row {...appLinkProps(url)} />;
 * }
 * ```
 *
 * | free          | hook                 |
 * |---------------|----------------------|
 * | `navigate`    | `useNavigate()`      |
 * | `appLink`     | `useAppLink()`       |
 * | `appLinkProps`| `useAppLinkProps()`  |
 *
 * "Inside React" is any reference — a call, or the function passed as a value
 * — lexically within a function named like a hook (`use*`) or a component
 * (PascalCase): a function declaration's or expression's own name, the
 * variable an arrow / function is bound to, or the variable a wrapper call
 * (`memo(…)`, `forwardRef(…)`) around it is bound to. Callers outside React —
 * a module-level helper, a store, a command handler with no component around
 * it — have no boundary to respect and stay legal. JSX counts too, wherever it
 * is written: a table column's `cell: (r) => <Chip activation={appLink(…)}/>`
 * at module level renders inside React all the same. A namespace import
 * (`tabs.navigate`) is the same reference by another spelling.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** The barrel exporting the free forms. */
const TABS_BARREL = "@plugins/apps-core/plugins/tabs/web";

/** Each free form → the hook that reads the boundary. */
const HOOK_FOR: Record<string, string> = {
  navigate: "useNavigate",
  appLink: "useAppLink",
  appLinkProps: "useAppLinkProps",
};

const HOOK_NAME = /^use[A-Z0-9]/;
const COMPONENT_NAME = /^[A-Z]/;

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

function isFunction(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionDeclaration
  );
}

/** The name a function is known by: its own, its binding's, or its wrapper's binding's. */
function functionName(fn: FunctionNode): string | undefined {
  if (fn.id) return fn.id.name;
  let node: TSESTree.Node = fn;
  // `memo(() => …)`, `forwardRef(function (…) {…})`: the wrapper's binding.
  while (node.parent?.type === AST_NODE_TYPES.CallExpression)
    node = node.parent;
  const parent = node.parent;
  if (
    parent?.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.id.type === AST_NODE_TYPES.Identifier
  )
    return parent.id.name;
  return undefined;
}

/** Whoever renders the reference: the nearest component, hook or JSX, if any. */
function enclosingReactName(node: TSESTree.Node): string | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (
      n.type === AST_NODE_TYPES.JSXElement ||
      n.type === AST_NODE_TYPES.JSXFragment
    )
      return "a JSX render";
    if (!isFunction(n)) continue;
    const name = functionName(n);
    if (name && (HOOK_NAME.test(name) || COMPONENT_NAME.test(name)))
      return name;
  }
  return undefined;
}

export default createRule({
  name: "no-free-app-nav-in-react",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban the free navigate / appLink / appLinkProps inside a React component or hook — use useNavigate / useAppLink / useAppLinkProps, which respect an embed's AppNavBoundary.",
    },
    messages: {
      free:
        "`{{name}}` inside `{{owner}}` drives the host's tabs directly, past any AppNavBoundary (an in-process app embed). " +
        "Read it through the hook instead: `const {{name}} = {{hook}}();` — the same behavior outside an embed.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function report(node: TSESTree.Node, imported: string, hook: string): void {
      const owner = enclosingReactName(node);
      if (owner === undefined) return;
      context.report({
        node,
        messageId: "free",
        data: { name: imported, owner, hook },
      });
    }
    function check(
      spec: TSESTree.ImportSpecifier | TSESTree.ImportNamespaceSpecifier,
    ): void {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(spec),
        spec.local,
      );
      if (!variable) return;
      if (spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
        // `tabs.navigate(…)`: the member read is the reference.
        for (const ref of variable.references) {
          const member = ref.identifier.parent;
          if (
            member?.type !== AST_NODE_TYPES.MemberExpression ||
            member.object !== ref.identifier ||
            member.computed ||
            member.property.type !== AST_NODE_TYPES.Identifier
          )
            continue;
          const hook = HOOK_FOR[member.property.name];
          if (hook !== undefined) report(member, member.property.name, hook);
        }
        return;
      }
      const imported =
        spec.imported.type === AST_NODE_TYPES.Identifier
          ? spec.imported.name
          : spec.imported.value;
      const hook = HOOK_FOR[imported];
      if (hook === undefined) return;
      for (const ref of variable.references)
        report(ref.identifier, imported, hook);
    }
    return {
      ImportDeclaration(node) {
        if (node.source.value !== TABS_BARREL) return;
        for (const spec of node.specifiers) {
          if (
            spec.type === AST_NODE_TYPES.ImportSpecifier ||
            spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier
          )
            check(spec);
        }
      },
    };
  },
});
