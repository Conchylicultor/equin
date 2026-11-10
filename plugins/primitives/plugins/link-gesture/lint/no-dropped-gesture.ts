/**
 * Bans `PLAIN_GESTURE` inside an event-handler callback (`on*` prop).
 *
 * `PLAIN_GESTURE` means "there is no gesture to read" — right for a keyboard
 * shortcut or an open after a mutation settles, wrong for anything the user
 * can click. In a click-style handler it is the signature of a link forced
 * through a component that only takes a callback:
 *
 * ```tsx
 * <ControlPanel.Row onSelect={() => runActivation(editor, PLAIN_GESTURE)} /> // ✗
 * <ControlPanel.Row activation={editor} />                                   // ✓
 * creators={[{ onSelect: () => newApp.open(PLAIN_GESTURE) }]}               // ✗
 * creators={[{ activation: newApp }]}                                       // ✓
 * ```
 *
 * The callback throws the user's ⌘/Ctrl-, middle- and ⌥-click away; the fix is
 * to hand the `LinkTarget` / `Activation` to the component as data (adding an
 * `activation` prop to it if it has none), which then spreads
 * `activationProps` / `linkProps`.
 *
 * It complements `no-click-navigate`, which knows a navigating CALL but only on
 * a fixed list of prop names: this rule keys on the gesture being discarded, so
 * it catches the link whatever the receiving prop is called (`onSelect`,
 * `onAction`, `onFilterRow`, …). It fires on a `PLAIN_GESTURE` imported from
 * link-gesture's core barrel whose nearest enclosing function is the value
 * (inline, possibly behind `?:` / `&&` / `useCallback`) of a JSX attribute or
 * object property named `on[A-Z]…`, except the props that never carry a
 * pointer gesture: key handlers, value changes, and past-tense events
 * (`onCreated`, `onDeleted` — an open after a mutation settled).
 *
 * Closed: a genuine no-gesture handler escapes per site with
 * `// eslint-disable-next-line link-gesture/no-dropped-gesture -- <reason>`.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const CORE_BARREL = "@plugins/primitives/plugins/link-gesture/core";

/** An event-handler prop. */
const HANDLER = /^on[A-Z]/;

/**
 * Handler props with no pointer gesture to read: a key press, a picked value —
 * and any past-tense event (`onCreated`, `onDeleted`, `onTaskCreated`): an open
 * run once a mutation settled, long after the click that started it.
 */
const NO_GESTURE = new Set([
  "onKeyDown",
  "onKeyUp",
  "onKeyPress",
  "onSuccess",
  "onSettled",
  "onChange",
  "onValueChange",
]);
const PAST_TENSE = /ed$/;

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

/** The prop name a function is the value of, looking through `?:`, `&&`, `useCallback(fn)`. */
function handlerPropOf(fn: FunctionNode): string | undefined {
  let node: TSESTree.Node = fn;
  for (;;) {
    const parent: TSESTree.Node | undefined = node.parent;
    if (parent === undefined) return undefined;
    if (
      parent.type === AST_NODE_TYPES.ConditionalExpression ||
      parent.type === AST_NODE_TYPES.LogicalExpression ||
      parent.type === AST_NODE_TYPES.TSAsExpression ||
      parent.type === AST_NODE_TYPES.TSSatisfiesExpression
    ) {
      node = parent;
      continue;
    }
    if (
      parent.type === AST_NODE_TYPES.CallExpression &&
      parent.callee.type === AST_NODE_TYPES.Identifier &&
      parent.callee.name === "useCallback" &&
      parent.arguments[0] === node
    ) {
      // A named handler: `const onX = useCallback(…)`.
      const decl = parent.parent;
      if (
        decl?.type === AST_NODE_TYPES.VariableDeclarator &&
        decl.id.type === AST_NODE_TYPES.Identifier
      )
        return decl.id.name;
      node = parent;
      continue;
    }
    if (parent.type === AST_NODE_TYPES.JSXExpressionContainer) {
      const attr = parent.parent;
      return attr?.type === AST_NODE_TYPES.JSXAttribute &&
        attr.name.type === AST_NODE_TYPES.JSXIdentifier
        ? attr.name.name
        : undefined;
    }
    if (
      parent.type === AST_NODE_TYPES.Property &&
      parent.value === node &&
      !parent.computed
    ) {
      const key = parent.key;
      if (key.type === AST_NODE_TYPES.Identifier) return key.name;
      if (key.type === AST_NODE_TYPES.Literal && typeof key.value === "string")
        return key.value;
      return undefined;
    }
    return undefined;
  }
}

function enclosingFunction(node: TSESTree.Node): FunctionNode | undefined {
  for (let n = node.parent; n !== undefined; n = n.parent)
    if (isFunction(n)) return n;
  return undefined;
}

export default createRule({
  name: "no-dropped-gesture",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban PLAIN_GESTURE inside an on* event handler — a clickable link forced through a callback loses ⌘/middle-click; pass the LinkTarget as `activation` instead.",
    },
    messages: {
      dropped:
        "`PLAIN_GESTURE` in this `{{name}}` handler throws the user's gesture away: ⌘/Ctrl- and middle-click cannot open a new tab. " +
        "Hand the LinkTarget / Activation to the component as data (its `activation` prop — add one if it has none) instead of running it in a callback.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      Identifier(node) {
        if (node.name !== "PLAIN_GESTURE") return;
        const parent = node.parent;
        // Only a READ (not the import specifier or a declaration).
        if (
          parent.type === AST_NODE_TYPES.ImportSpecifier ||
          parent.type === AST_NODE_TYPES.VariableDeclarator ||
          (parent.type === AST_NODE_TYPES.MemberExpression &&
            parent.property === node)
        )
          return;
        const variable = ASTUtils.findVariable(
          context.sourceCode.getScope(node),
          node,
        );
        const def = variable?.defs[0];
        if (
          def?.type !== "ImportBinding" ||
          def.parent?.type !== AST_NODE_TYPES.ImportDeclaration ||
          def.parent.source.value !== CORE_BARREL
        )
          return;
        const fn = enclosingFunction(node);
        if (fn === undefined) return;
        const name = handlerPropOf(fn);
        if (
          name === undefined ||
          !HANDLER.test(name) ||
          NO_GESTURE.has(name) ||
          PAST_TENSE.test(name)
        )
          return;
        context.report({ node, messageId: "dropped", data: { name } });
      },
    };
  },
});
