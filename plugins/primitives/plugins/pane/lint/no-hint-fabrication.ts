/**
 * Bans fabricating server-owned state out of a pane `Hint`. A `Hint<T>` is an
 * OPTIMISTIC MIRROR of server-owned state, supplied by whoever opened the pane —
 * and it is absent on a deep link / reload, where the route is rebuilt from the
 * URL alone. Its single access API, `pick(key, canonical)`, forces the caller to
 * name the canonical value in the same expression, but the result is still
 * `T[K] | undefined`, and `undefined ?? "Untitled"` is one keystroke from writing
 * a fabricated value to the DB. That exact bug destroyed a Sonata song's title
 * (see `research/2026-07-10-sonata-song-title-single-owner.md` and
 * `research/2026-07-10-global-pane-input-hint-vs-options.md`). A hint may only be
 * observed alongside its source of truth, and may only fall back to a value that
 * can never be written back.
 *
 * A `pick(...)` call is a Hint access when its receiver is a Hint. The receiver
 * is detected by SCOPE — never by name — in three forms:
 *   - a binding initialized from `<x>.useHint()` (e.g. `const h = pane.useHint()`),
 *   - a parameter (or binding) whose TS type annotation is `Hint<…>` (also reached
 *     through a qualified name like `Pane.Hint<…>` — the right-most identifier),
 *   - the direct inline call `<x>.useHint().pick(...)`.
 *
 * Two violations fire on such a receiver's `pick(...)`:
 *
 * (A) `bareHint` — the SECOND argument (the canonical value) is a literal
 *     `undefined`, `null`, or `void 0`, or `pick` is called with fewer than two
 *     arguments at all. Passing no canonical value recovers the bare hint, which
 *     is the precise thing the API exists to prevent: the hint may only be
 *     observed alongside its source of truth, never on its own. (tsc enforces the
 *     arity too, but the lint message is the teaching one.)
 *
 * (B) `hintFabrication` — the RESULT of a `pick(...)` call is the LEFT operand of a
 *     `??` / `||` whose RIGHT operand is anything OTHER than `null`, `undefined`,
 *     `void 0`, or a JSXElement/JSXFragment. A *display* placeholder must be a
 *     ReactNode (which can never be a DB value); a fabricated string/number/boolean
 *     default is the bug. Sanctioned shapes: `?? null`, `?? undefined`,
 *     `?? <Placeholder>…</Placeholder>`, or an explicit branch. Detected in two
 *     forms — the direct `h.pick("k", x) ?? "Untitled"`, and the one-level const
 *     `const v = h.pick("k", x); … v ?? "Untitled"` (the initializer is resolved
 *     through the same scope-walk as the rest of the rule).
 *
 * Not type-aware: pure scope resolution, exactly like
 * `live-state/no-pending-data-collapse`. No name guessing — a parameter merely
 * *named* `hint` is never matched; only a `Hint`-typed or `useHint()`-sourced
 * receiver is.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { TSESLint } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

type Ctx = Readonly<TSESLint.RuleContext<"bareHint" | "hintFabrication", []>>;

function resolveVariable(
  context: Ctx,
  ident: TSESTree.Identifier,
): TSESLint.Scope.Variable | null {
  let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(ident);
  while (scope) {
    const v = scope.variables.find((v) => v.name === ident.name);
    if (v) return v;
    scope = scope.upper;
  }
  return null;
}

function initializerOf(
  context: Ctx,
  ident: TSESTree.Identifier,
): TSESTree.Expression | null {
  const def = resolveVariable(context, ident)?.defs[0];
  if (!def || def.node.type !== AST_NODE_TYPES.VariableDeclarator) return null;
  return def.node.init ?? null;
}

/** Strip `x as T` / `<T>x` / parenthesized wrappers. */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.type === AST_NODE_TYPES.TSAsExpression ||
    n.type === AST_NODE_TYPES.TSTypeAssertion ||
    n.type === AST_NODE_TYPES.TSNonNullExpression
  ) {
    n = n.expression;
  }
  return n;
}

/** Is `node` a call `<x>.useHint()` (member callee, property name `useHint`)? */
function isUseHintCall(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type !== AST_NODE_TYPES.CallExpression) return false;
  const callee = n.callee;
  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "useHint"
  );
}

/** Right-most identifier of a `Hint` / `Pane.Hint` type-reference name. */
function typeNameIsHint(name: TSESTree.EntityName): boolean {
  if (name.type === AST_NODE_TYPES.Identifier) return name.name === "Hint";
  if (name.type === AST_NODE_TYPES.TSQualifiedName) return name.right.name === "Hint";
  return false;
}

/** Does an identifier's TS annotation say `Hint<…>` (or `Pane.Hint<…>`)? */
function isHintAnnotation(ann: TSESTree.TSTypeAnnotation | undefined): boolean {
  if (!ann) return false;
  const t = ann.typeAnnotation;
  if (t.type !== AST_NODE_TYPES.TSTypeReference) return false;
  return typeNameIsHint(t.typeName);
}

/**
 * Is `node` a Hint receiver — a binding sourced from `<x>.useHint()`, a binding
 * annotated `Hint<…>` (parameter or otherwise), or the direct inline call
 * `<x>.useHint()`? Detected purely by scope + type annotation; never by name.
 */
function isHintReceiver(context: Ctx, node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === AST_NODE_TYPES.CallExpression) return isUseHintCall(n);
  if (n.type !== AST_NODE_TYPES.Identifier) return false;
  const v = resolveVariable(context, n);
  if (!v) return false;
  for (const def of v.defs) {
    if (
      def.node.type === AST_NODE_TYPES.VariableDeclarator &&
      def.node.init &&
      isUseHintCall(def.node.init)
    ) {
      return true;
    }
    if (def.name.type === AST_NODE_TYPES.Identifier && isHintAnnotation(def.name.typeAnnotation)) {
      return true;
    }
  }
  return false;
}

/** Is `node` a `<hintReceiver>.pick(...)` call? */
function isHintPick(context: Ctx, node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type !== AST_NODE_TYPES.CallExpression) return false;
  const callee = n.callee;
  if (
    callee.type !== AST_NODE_TYPES.MemberExpression ||
    callee.computed ||
    callee.property.type !== AST_NODE_TYPES.Identifier ||
    callee.property.name !== "pick"
  ) {
    return false;
  }
  return isHintReceiver(context, callee.object);
}

/** A bare `undefined` / `null` / `void 0` — the values that recover the raw hint. */
function isBareUndefinedNull(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === AST_NODE_TYPES.Identifier) return n.name === "undefined";
  if (n.type === AST_NODE_TYPES.Literal) return n.value === null;
  if (n.type === AST_NODE_TYPES.UnaryExpression) return n.operator === "void";
  return false;
}

/**
 * A sanctioned `??`/`||` fallback for a hint pick: `null`, `undefined`, `void 0`,
 * or a JSXElement/JSXFragment (a display placeholder is a ReactNode, which can
 * never be written back to the DB). Anything else fabricates server-owned state.
 */
function isSanctionedFallback(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === AST_NODE_TYPES.Literal) return n.value === null;
  if (n.type === AST_NODE_TYPES.Identifier) return n.name === "undefined";
  if (n.type === AST_NODE_TYPES.UnaryExpression) return n.operator === "void";
  return n.type === AST_NODE_TYPES.JSXElement || n.type === AST_NODE_TYPES.JSXFragment;
}

/** Source text of a node, truncated to ~30 chars for the message data slot. */
function truncated(context: Ctx, node: TSESTree.Node): string {
  const text = context.sourceCode.getText(node).replace(/\s+/g, " ");
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

export default createRule({
  name: "no-hint-fabrication",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow recovering a bare pane hint or defaulting a hint `pick()` to a fabricated value — a hint is an optimistic mirror of server-owned state, absent on a deep link, never a write source.",
    },
    schema: [],
    messages: {
      bareHint:
        "`pick()` requires the canonical value as its second argument. A hint is an optimistic mirror of " +
        "server-owned state and is absent on a deep link — it may only be observed alongside its source of " +
        "truth, never on its own.",
      hintFabrication:
        "Defaulting a pane hint to `{{value}}` fabricates server-owned state when the hint is absent (deep " +
        "link / reload) and the canonical value is still loading. Fall back to `null`/`undefined`, or to a " +
        "JSX placeholder — never to a value that could be written back.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // (A) bareHint — `<hint>.pick(k)` / `<hint>.pick(k, undefined|null|void 0)`.
      CallExpression(node) {
        if (!isHintPick(context, node)) return;
        const canonical = node.arguments[1];
        if (node.arguments.length < 2 || (canonical && isBareUndefinedNull(canonical))) {
          context.report({ node, messageId: "bareHint" });
        }
      },
      // (B) hintFabrication — `<hint>.pick(k, x) ?? <fabricated>` (direct or via a
      // one-level const), where the fallback is not null/undefined/void 0/JSX.
      LogicalExpression(node) {
        if (node.operator !== "??" && node.operator !== "||") return;
        const left = unwrap(node.left);
        let fromPick = isHintPick(context, left);
        if (!fromPick && left.type === AST_NODE_TYPES.Identifier) {
          const init = initializerOf(context, left);
          fromPick = init !== null && isHintPick(context, init);
        }
        if (!fromPick) return;
        if (isSanctionedFallback(node.right)) return;
        context.report({
          node,
          messageId: "hintFabrication",
          data: { value: truncated(context, node.right) },
        });
      },
    };
  },
});
