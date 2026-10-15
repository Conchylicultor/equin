/**
 * Bans a click-style callback whose whole job is to navigate.
 *
 * A control that navigates is a LINK: ⌘/Ctrl-click and middle-click must open
 * its destination in a new browser tab, as they would on an `<a href>`. A bare
 * callback cannot do that — a middle-click fires `onAuxClick`, never `onClick`,
 * and the callback throws the modifiers away — so the control silently loses
 * the gesture. The fix is to hand over the destination as DATA (a
 * `LinkTarget`: where a plain click goes, and the URL an "elsewhere" gesture
 * opens), which the receiving primitive wires to every gesture:
 *
 * ```tsx
 * <Button onClick={() => openPane(p, { id }, { mode: "push" })} />       // ✗
 * <Button {...openPane.link(p, { id }, { mode: "push" })} />             // ✓
 * <LinkChip activation={openPane.to(p, { id }, { mode: "push" })} />     // ✓
 * <Row activation={appLink(url)} />                                      // ✓ (tabs' navigate)
 * <DataView rowActivation={(r) => () => openPane(p, { id: r.id })} />    // ✗
 * <DataView rowActivation={(r) => openPane.to(p, { id: r.id })} />       // ✓
 * ```
 *
 * A *navigating call* is `openPane(…)` / `<x>.openPane(…)`; the tabs barrel's
 * `navigate(…)` (resolved by import, so the browser app's own `navigate` is
 * not one) unless it asks for `{ newTab: true }` (a new in-app tab is an
 * explicit menu entry, not a link gesture); a call of — or a method call on,
 * other than its `link` / `to` / `href` forms — a binding initialised from
 * `useOpenPane()` or `use*Opener()`; and a zero-argument `<x>.open()` (a
 * `LinkTarget` run by hand). Not every `useOpen*()`: `useOpenHostFile()` opens
 * a file in its default app — an action with no URL, so no link to be.
 *
 * A callback *only navigates* when its body is a navigating call (optionally
 * `void`ed), or a block of zero or more `e.stopPropagation()` /
 * `e.preventDefault()` statements followed by exactly one navigating call (as
 * a statement or a `return`). Isolation is not a reason to keep a callback:
 * `activationProps(target, { isolate: true })` stops propagation itself.
 *
 * It fires on handler props (`onClick`, `onRowClick`, `onRowActivate`,
 * `onNodeClick`, `onOpen`, `onActivate`, `onNavigate`, `onOpenFile`,
 * `onFileOpen`) — JSX attributes and object properties alike, inline or a
 * same-file named handler (`const` arrow, `function`, `useCallback(fn)`) — and
 * on activation props (`activation`, `rowActivation`, `nodeActivation`,
 * `commitActivation`) whose value is such a callback or a resolver returning
 * one. Not flagged: `onSelect`, `onCreated` / `onSuccess` (an open after a
 * mutation has no gesture to read), and any handler doing other work besides.
 *
 * A callback that BUILDS a `LinkTarget` and discards it (`() => openPane.to(…)`)
 * is not this rule's job: `Activation`'s function arm returns `void | undefined`,
 * so tsc rejects it.
 *
 * Closed: a genuine non-link escapes per site with
 * `// eslint-disable-next-line link-gesture/no-click-navigate -- <reason>`.
 */
import {
  AST_NODE_TYPES,
  ASTUtils,
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** Props whose value is a callback run when the control is activated. */
const HANDLER_PROPS = new Set([
  "onClick",
  "onRowClick",
  "onRowActivate",
  "onNodeClick",
  "onOpen",
  "onActivate",
  "onNavigate",
  "onOpenFile",
  "onFileOpen",
]);

/** Props whose value is an `Activation`, or a resolver returning one. */
const ACTIVATION_PROPS = new Set([
  "activation",
  "rowActivation",
  "nodeActivation",
  "commitActivation",
]);

/** The barrel whose `navigate` is the cross-app navigation. */
const TABS_BARREL = "@plugins/apps-core/plugins/tabs/web";

/** A hook whose return value navigates when called. */
const OPENER_HOOK = /^(useOpenPane|use\w*Opener)$/;

/** An opener's methods that build a link rather than navigate. */
const LINK_FORMS = new Set(["link", "to", "href"]);

type Context = Readonly<TSESLint.RuleContext<string, []>>;

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

function isFunction(
  node: TSESTree.Node | null | undefined,
): node is FunctionNode {
  return (
    node?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node?.type === AST_NODE_TYPES.FunctionExpression ||
    node?.type === AST_NODE_TYPES.FunctionDeclaration
  );
}

function definitionOf(
  context: Context,
  id: TSESTree.Identifier,
): TSESLint.Scope.Definition | undefined {
  const scope = context.sourceCode.getScope(id);
  return ASTUtils.findVariable(scope, id)?.defs[0];
}

/** `navigate` imported from the tabs barrel. */
function isTabsNavigate(context: Context, id: TSESTree.Identifier): boolean {
  const def = definitionOf(context, id);
  return (
    def?.type === "ImportBinding" &&
    def.parent?.type === AST_NODE_TYPES.ImportDeclaration &&
    def.parent.source.value === TABS_BARREL
  );
}

/** A binding initialised from `useOpenPane()` / `use*Opener()`. */
function isOpenerBinding(context: Context, id: TSESTree.Identifier): boolean {
  const def = definitionOf(context, id);
  if (def?.type !== "Variable") return false;
  const decl = def.node;
  if (decl.type !== AST_NODE_TYPES.VariableDeclarator) return false;
  if (decl.id.type !== AST_NODE_TYPES.Identifier) return false;
  const init = decl.init;
  return (
    init?.type === AST_NODE_TYPES.CallExpression &&
    init.callee.type === AST_NODE_TYPES.Identifier &&
    OPENER_HOOK.test(init.callee.name)
  );
}

/** `{ …, newTab: true }` — an explicit new in-app tab, never a link gesture. */
function asksNewTab(arg: TSESTree.Node | undefined): boolean {
  if (arg?.type !== AST_NODE_TYPES.ObjectExpression) return false;
  return arg.properties.some(
    (p) =>
      p.type === AST_NODE_TYPES.Property &&
      !p.computed &&
      p.key.type === AST_NODE_TYPES.Identifier &&
      p.key.name === "newTab" &&
      p.value.type === AST_NODE_TYPES.Literal &&
      p.value.value === true,
  );
}

function isNavigatingCall(
  context: Context,
  node: TSESTree.Node | null | undefined,
): boolean {
  if (node?.type === AST_NODE_TYPES.UnaryExpression && node.operator === "void")
    return isNavigatingCall(context, node.argument);
  if (node?.type !== AST_NODE_TYPES.CallExpression) return false;
  const callee = node.callee;
  if (callee.type === AST_NODE_TYPES.Identifier) {
    if (callee.name === "openPane") return true;
    if (callee.name === "navigate")
      return isTabsNavigate(context, callee) && !asksNewTab(node.arguments[1]);
    return isOpenerBinding(context, callee);
  }
  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier
  )
    return false;
  const method = callee.property.name;
  if (method === "openPane") return true;
  if (method === "open" && node.arguments.length === 0) return true;
  return (
    !LINK_FORMS.has(method) &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    isOpenerBinding(context, callee.object)
  );
}

/** `e.stopPropagation()` / `e.preventDefault()` — isolation, not work. */
function isIsolation(stmt: TSESTree.Statement): boolean {
  if (stmt.type !== AST_NODE_TYPES.ExpressionStatement) return false;
  const call = stmt.expression;
  return (
    call.type === AST_NODE_TYPES.CallExpression &&
    call.callee.type === AST_NODE_TYPES.MemberExpression &&
    !call.callee.computed &&
    call.callee.property.type === AST_NODE_TYPES.Identifier &&
    (call.callee.property.name === "stopPropagation" ||
      call.callee.property.name === "preventDefault")
  );
}

/** A function whose whole job is one navigating call. */
function onlyNavigates(context: Context, fn: FunctionNode): boolean {
  const body = fn.body;
  if (body.type !== AST_NODE_TYPES.BlockStatement)
    return isNavigatingCall(context, body);
  const stmts = body.body;
  const last = stmts.at(-1);
  if (last === undefined) return false;
  if (!stmts.slice(0, -1).every(isIsolation)) return false;
  if (last.type === AST_NODE_TYPES.ExpressionStatement)
    return isNavigatingCall(context, last.expression);
  if (last.type === AST_NODE_TYPES.ReturnStatement)
    return isNavigatingCall(context, last.argument);
  return false;
}

/**
 * The function a prop value names: inline, or a same-file named handler — a
 * `const` arrow / function expression, a `function` declaration, or
 * `useCallback(fn, deps)`.
 */
function resolveFunction(
  context: Context,
  value: TSESTree.Node,
): FunctionNode | undefined {
  if (isFunction(value)) return value;
  if (value.type !== AST_NODE_TYPES.Identifier) return undefined;
  const def = definitionOf(context, value);
  if (def?.type === "FunctionName" && isFunction(def.node)) return def.node;
  if (def?.type !== "Variable") return undefined;
  const decl = def.node;
  if (decl.type !== AST_NODE_TYPES.VariableDeclarator) return undefined;
  const init = decl.init;
  if (isFunction(init)) return init;
  if (
    init?.type === AST_NODE_TYPES.CallExpression &&
    init.callee.type === AST_NODE_TYPES.Identifier &&
    init.callee.name === "useCallback" &&
    isFunction(init.arguments[0])
  )
    return init.arguments[0];
  return undefined;
}

type Finding = "handler" | "activation" | "resolver";

/** Why the value of a prop named `name` is a navigation-only callback, if it is. */
function classify(
  context: Context,
  name: string,
  value: TSESTree.Node,
): Finding | undefined {
  if (HANDLER_PROPS.has(name)) {
    const fn = resolveFunction(context, value);
    return fn && onlyNavigates(context, fn) ? "handler" : undefined;
  }
  if (!ACTIVATION_PROPS.has(name)) return undefined;
  const fn = resolveFunction(context, value);
  if (fn === undefined) return undefined;
  if (onlyNavigates(context, fn)) return "activation";
  // A resolver `(row) => () => <navigating call>`.
  if (
    fn.body.type !== AST_NODE_TYPES.BlockStatement &&
    isFunction(fn.body) &&
    onlyNavigates(context, fn.body)
  )
    return "resolver";
  return undefined;
}

const FIX =
  "Hand over the destination as data instead: spread `{...openPane.link(pane, params, opts)}` on a control, " +
  "or pass a LinkTarget — `openPane.to(pane, params, opts)`, `appLink(url)`, an opener's target — as its `activation`.";

export default createRule({
  name: "no-click-navigate",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban a click callback whose only job is to navigate — pass a LinkTarget (openPane.link / openPane.to / appLink) so ⌘/middle-click open a browser tab.",
    },
    messages: {
      handler:
        "This `{{name}}` callback only navigates, so the control is a link — but a callback drops ⌘/Ctrl- and middle-click. " +
        FIX,
      activation:
        "This `{{name}}` is a plain action that only navigates, so ⌘/Ctrl- and middle-click do nothing. " +
        "Pass a LinkTarget instead — `openPane.to(pane, params, opts)`, `appLink(url)`, an opener's target — so they open a browser tab.",
      resolver:
        "This `{{name}}` resolver hands back an action that only navigates, so ⌘/Ctrl- and middle-click do nothing. " +
        "Return a LinkTarget instead: `(row) => openPane.to(pane, params, opts)` / `appLink(url)` (same arguments).",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== AST_NODE_TYPES.JSXIdentifier) return;
        const value = node.value;
        if (value?.type !== AST_NODE_TYPES.JSXExpressionContainer) return;
        if (value.expression.type === AST_NODE_TYPES.JSXEmptyExpression) return;
        const name = node.name.name;
        const finding = classify(context, name, value.expression);
        if (finding)
          context.report({ node, messageId: finding, data: { name } });
      },
      Property(node) {
        if (node.computed) return;
        if (node.parent.type !== AST_NODE_TYPES.ObjectExpression) return;
        const key = node.key;
        const name =
          key.type === AST_NODE_TYPES.Identifier
            ? key.name
            : key.type === AST_NODE_TYPES.Literal &&
                typeof key.value === "string"
              ? key.value
              : undefined;
        if (name === undefined) return;
        const finding = classify(context, name, node.value);
        if (finding)
          context.report({ node, messageId: finding, data: { name } });
      },
    };
  },
});
