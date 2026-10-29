/**
 * Bans the `result.pending ? <emptyDefault> : result.data` idiom on resource
 * results. That ternary collapses "still loading" and "genuinely empty" into
 * the same value at the exact line where the distinction still exists — the
 * root of the wrong-state-while-loading bug class (empty states, zero counts,
 * and destructive default button modes flashing during the load window).
 *
 * Flags a ConditionalExpression when ALL of:
 *   - the test is `X.pending` (or `!X.pending`, branches swapped) — or its
 *     `status` spelling, `X.status !== "ready"` (or `=== "ready"`, swapped),
 *   - X is a binding initialized from a resource read (`RESOURCE_HOOKS`:
 *     useLive / useResource / useOptimisticResource / combineResources /
 *     useCombinedResources / useConfigResult / useLive / useSlotOrder /
 *     useReorderedEntries / useLayoutOrder / useZStackIndex),
 *   - the pending branch is an empty default ([], {}, null, false, 0, "",
 *     undefined, or a const initialized to one of those),
 *   - the settled branch references `X.data`.
 *
 * The same conceptual ban has a second syntactic form — the early-return
 * statement `if (X.pending) return <typed-empty>` followed by a later
 * `return <…X.data…>`. The IfStatement visitor flags that form when ALL of:
 *   - the test is `X.pending` or `X.status !== "ready"` (the direct form
 *     only; `!X.pending` with an inverted block body is NOT covered — see the
 *     visitor comment),
 *   - X is a resource-result binding (same hooks + the same select carve-out),
 *   - the consequent (a bare ReturnStatement, or a block whose only statement is
 *     one) returns a TYPED-EMPTY data stand-in: a non-`null`/`undefined` empty
 *     literal ([], {}, 0, "", false), or a wrapper structurally parallel to the
 *     data-return (`{ files: [] }` against `return { files: X.data }`),
 *   - a SUBSEQUENT `return` in the same function references `X.data` AND is NOT
 *     a JSXElement/JSXFragment. The non-JSX guard is load-bearing: it limits the
 *     ban to functions producing a consumable VALUE (a hook/derivation); a
 *     component that early-returns while pending and then renders `X.data` in JSX
 *     is the sanctioned shape and must never be flagged.
 *
 * A `null`/`undefined` early-return is flagged too, but only when the later
 * value-return can ITSELF produce `null`/`undefined` — it contains a
 * `null`/`undefined` literal (`?? null`, `? … : null`) or an optional chain
 * (`rows[0] ?? null` narrowing a one-id read to "the row, or absent"). Then
 * "not loaded yet" and "absent" reach the caller as the same value, which is
 * the bug (a picker showing "Off" for an armed task during the load window).
 * When the value-return can never be nullish, a pending `null` stays a distinct
 * "not yet" the caller must check, and is allowed. The non-JSX guard still
 * keeps a component's "render nothing while loading" early-return legal.
 *
 * Carve-out: a pane title hook — the `useText:` of a `title: { … }` object
 * (`Pane.define({ title: { useText, fallback } })`), written inline or as a
 * function declared in the file and passed there — may return `undefined` while
 * pending. Pane's title contract defines `undefined` as "show the title's
 * `fallback`", which is the right thing to show while loading as well as when
 * the entity is gone — so nothing wrong reaches the screen.
 *
 * Carve-out (favor false negatives): `useResource(…, { select })` results are
 * sanctioned point reads where `pending ? null : q.data` is legitimate.
 *
 * Sanctioned replacements: early-return on `.pending`, <ResourceView>/
 * matchResource(...), combineResources(...) for multi-resource views, or
 * DataView's `readiness` prop. See plugins/primitives/plugins/live-state/CLAUDE.md.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { TSESLint } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const RESOURCE_HOOKS = new Set([
  "useResource",
  "useOptimisticResource",
  "combineResources",
  "useCombinedResources",
  // config_v2's readiness-carrying read returns the same `ResourceResult` shape,
  // and collapsing ITS pending arm is the same bug with a worse disguise: a
  // config's empty defaults read as a legitimate answer, so the wrong state is
  // indistinguishable from a real one.
  "useConfigResult",
  // `network/live`'s read — the one bounded read of a collection (a window, a
  // grouping or an id set) and of a value: a `ResourceResult<Row[]>` (plus
  // paging handles on a window's settled arm) or `ResourceResult<T>`, so
  // `pending ? [] : r.data` is the same collapse.
  // `useLiveRow` needs no entry — it has no `data` to collapse into: its
  // settled arms are `found: true` (with `row`) and `found: false`.
  "useLive",
  // A slot's layout order is a read too (`ResourceResult`): `loading` until
  // the slot's config is known. Collapsing it to `[]` or to the raw
  // contributions is the first-paint flash the result exists to prevent.
  "useSlotOrder",
  "useReorderedEntries",
  "useLayoutOrder",
  // The z-stack index derives from the z-layers slot's layout order.
  "useZStackIndex",
]);

type Ctx = Readonly<
  TSESLint.RuleContext<"pendingCollapse" | "pendingCollapseReturn", []>
>;

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

function isEmptyDefaultLiteral(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === AST_NODE_TYPES.ArrayExpression) return n.elements.length === 0;
  if (n.type === AST_NODE_TYPES.ObjectExpression)
    return n.properties.length === 0;
  if (n.type === AST_NODE_TYPES.Literal) {
    return (
      n.value === null || n.value === false || n.value === 0 || n.value === ""
    );
  }
  if (n.type === AST_NODE_TYPES.Identifier) return n.name === "undefined";
  return false;
}

function isEmptyDefault(context: Ctx, node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (isEmptyDefaultLiteral(n)) return true;
  // Hoisted `const EMPTY = []` style defaults — resolve one level.
  if (n.type === AST_NODE_TYPES.Identifier) {
    const init = initializerOf(context, n);
    return init !== null && isEmptyDefaultLiteral(init);
  }
  return false;
}

/**
 * Empty default literal EXCLUDING `null`/`undefined`. The statement form uses
 * this stricter variant because a `null`/`undefined` early-return signals
 * genuine absence the caller must null-check — it is the sanctioned "render
 * nothing / no value yet while loading" shape, not a fake-empty collapse. So
 * `[]`, `{}`, `0`, `""`, `false` count; `null` and `undefined` do not.
 */
function isEmptyDefaultLiteralNonNull(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === AST_NODE_TYPES.ArrayExpression) return n.elements.length === 0;
  if (n.type === AST_NODE_TYPES.ObjectExpression)
    return n.properties.length === 0;
  if (n.type === AST_NODE_TYPES.Literal) {
    return n.value === false || n.value === 0 || n.value === "";
  }
  return false;
}

/** Non-computed string/identifier key name of an object property, or null. */
function propKeyName(p: TSESTree.ObjectLiteralElement): string | null {
  if (p.type !== AST_NODE_TYPES.Property || p.computed) return null;
  if (p.key.type === AST_NODE_TYPES.Identifier) return p.key.name;
  if (
    p.key.type === AST_NODE_TYPES.Literal &&
    typeof p.key.value === "string"
  ) {
    return p.key.value;
  }
  return null;
}

/**
 * Is `pending` a TYPED-EMPTY stand-in for the data-return `data`? I.e. the
 * data-return value with every `X.data` position swapped for an empty literal.
 * Two shapes:
 *   - a bare non-null empty literal ([], {}, 0, "", false) — the data-return is
 *     then a direct `X.data` (or an expression referencing it).
 *   - a wrapper structurally parallel to the data-return: same object keys (or
 *     same array arity), and for every position the data-return references
 *     `X.data` while the pending value is a non-null empty literal. The common
 *     case is the object wrapper `{ files: [] }` vs `return { files: X.data }`.
 * `objName` is the resource binding so we can require the data-return positions
 * to actually reference IT (not some unrelated value).
 */
function isTypedEmptyStandIn(
  pending: TSESTree.Node,
  data: TSESTree.Node,
  objName: string,
): boolean {
  const p = unwrap(pending);
  // Bare empty literal — accept as long as the data-return references X.data.
  if (isEmptyDefaultLiteralNonNull(p)) {
    return referencesData(data, objName);
  }
  const d = unwrap(data);
  // Wrapped object: { files: [] } vs { files: X.data } — keys must match and
  // each pending value is an empty literal where the data value references data.
  if (
    p.type === AST_NODE_TYPES.ObjectExpression &&
    d.type === AST_NODE_TYPES.ObjectExpression &&
    p.properties.length > 0 &&
    p.properties.length === d.properties.length
  ) {
    return p.properties.every((pp) => {
      const key = propKeyName(pp);
      if (key === null || pp.type !== AST_NODE_TYPES.Property) return false;
      const dp = d.properties.find((x) => propKeyName(x) === key);
      if (!dp || dp.type !== AST_NODE_TYPES.Property) return false;
      return (
        isEmptyDefaultLiteralNonNull(pp.value) &&
        referencesData(dp.value, objName)
      );
    });
  }
  // Wrapped array: [[]] vs [X.data] — same arity, positional parallel.
  if (
    p.type === AST_NODE_TYPES.ArrayExpression &&
    d.type === AST_NODE_TYPES.ArrayExpression &&
    p.elements.length > 0 &&
    p.elements.length === d.elements.length
  ) {
    return p.elements.every((pe, i) => {
      const de = d.elements[i];
      if (!pe || !de) return false;
      return isEmptyDefaultLiteralNonNull(pe) && referencesData(de, objName);
    });
  }
  return false;
}

/** The single ReturnStatement in a consequent (bare, or sole stmt of a block). */
function consequentReturn(
  consequent: TSESTree.Statement,
): TSESTree.ReturnStatement | null {
  if (consequent.type === AST_NODE_TYPES.ReturnStatement) return consequent;
  if (
    consequent.type === AST_NODE_TYPES.BlockStatement &&
    consequent.body.length === 1 &&
    consequent.body[0]?.type === AST_NODE_TYPES.ReturnStatement
  ) {
    return consequent.body[0];
  }
  return null;
}

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

/** Nearest enclosing function node walking up the parent chain. */
function enclosingFunction(node: TSESTree.Node): FunctionNode | null {
  let n: TSESTree.Node | undefined = node.parent;
  while (n) {
    if (
      n.type === AST_NODE_TYPES.FunctionDeclaration ||
      n.type === AST_NODE_TYPES.FunctionExpression ||
      n.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return n;
    }
    n = n.parent;
  }
  return null;
}

/**
 * The function's data-producing ReturnStatement: one (other than `exclude`)
 * whose argument references `<objName>.data` AND is NOT a JSXElement/JSXFragment.
 * The non-JSX guard is load-bearing — see the file header: a component that
 * early-returns while pending then renders `X.data` in JSX is the sanctioned
 * shape, not a collapse. Returns nested inside an INNER function are skipped
 * (they belong to a different enclosing scope). Returns null if none qualifies.
 */
function findDataReturn(
  fn: FunctionNode,
  objName: string,
  exclude: TSESTree.ReturnStatement,
): TSESTree.ReturnStatement | null {
  let found: TSESTree.ReturnStatement | null = null;
  const walk = (node: TSESTree.Node, depth: number) => {
    if (found) return;
    // Don't descend into a nested function — its returns belong to it.
    if (
      depth > 0 &&
      (node.type === AST_NODE_TYPES.FunctionDeclaration ||
        node.type === AST_NODE_TYPES.FunctionExpression ||
        node.type === AST_NODE_TYPES.ArrowFunctionExpression)
    ) {
      return;
    }
    if (
      node.type === AST_NODE_TYPES.ReturnStatement &&
      node !== exclude &&
      node.argument
    ) {
      const arg = unwrap(node.argument);
      const isJsx =
        arg.type === AST_NODE_TYPES.JSXElement ||
        arg.type === AST_NODE_TYPES.JSXFragment;
      if (!isJsx && referencesData(node.argument, objName)) {
        found = node;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (isAstNode(c)) walk(c, depth + 1);
        }
      } else if (isAstNode(child)) {
        walk(child, depth + 1);
      }
    }
  };
  walk(fn.body, 1);
  return found;
}

function isAstNode(value: unknown): value is TSESTree.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Does the branch reference `<objName>.data` anywhere in its subtree? */
function referencesData(node: TSESTree.Node, objName: string): boolean {
  if (
    node.type === AST_NODE_TYPES.MemberExpression &&
    !node.computed &&
    node.object.type === AST_NODE_TYPES.Identifier &&
    node.object.name === objName &&
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === "data"
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (isAstNode(c) && referencesData(c, objName)) return true;
      }
    } else if (isAstNode(child) && referencesData(child, objName)) {
      return true;
    }
  }
  return false;
}

/** The hook name `ident` was initialized from (`const X = useFoo(…)`), or null. */
function hookCallOf(
  context: Ctx,
  ident: TSESTree.Identifier,
): { name: string; call: TSESTree.CallExpression } | null {
  const init = initializerOf(context, ident);
  if (!init) return null;
  const call = unwrap(init);
  if (call.type !== AST_NODE_TYPES.CallExpression) return null;
  const callee = call.callee;
  const name =
    callee.type === AST_NODE_TYPES.Identifier
      ? callee.name
      : callee.type === AST_NODE_TYPES.MemberExpression &&
          callee.property.type === AST_NODE_TYPES.Identifier
        ? callee.property.name
        : null;
  return name ? { name, call } : null;
}

function isNullishLiteral(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  return (
    (n.type === AST_NODE_TYPES.Literal && n.value === null) ||
    (n.type === AST_NODE_TYPES.Identifier && n.name === "undefined")
  );
}

/**
 * Can this value-return expression produce `null`/`undefined`? True when its
 * subtree (not descending into nested functions, whose values are not this
 * return's) holds a `null`/`undefined` literal or an optional chain.
 */
function canBeNullish(node: TSESTree.Node): boolean {
  if (isNullishLiteral(node)) return true;
  if (node.type === AST_NODE_TYPES.ChainExpression) return true;
  if (
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return false;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (isAstNode(c) && canBeNullish(c)) return true;
      }
    } else if (isAstNode(child) && canBeNullish(child)) {
      return true;
    }
  }
  return false;
}

function propertyKeyIs(node: TSESTree.Node | undefined, key: string): boolean {
  return (
    node?.type === AST_NODE_TYPES.Property &&
    !node.computed &&
    ((node.key.type === AST_NODE_TYPES.Identifier && node.key.name === key) ||
      (node.key.type === AST_NODE_TYPES.Literal && node.key.value === key))
  );
}

/**
 * Is `node` the `useText:` property of a `title: { … }` object — the slot a pane
 * title hook is declared in (`Pane.define({ title: { useText: useX } })`)?
 */
function isTitleTextProperty(node: TSESTree.Node | undefined): boolean {
  if (!node || !propertyKeyIs(node, "useText")) return false;
  const object = node.parent;
  return (
    object?.type === AST_NODE_TYPES.ObjectExpression &&
    propertyKeyIs(object.parent, "title") &&
    (object.parent as TSESTree.Property).value === object
  );
}

/**
 * Is `fn` a pane title hook? Either written inline as the `useText:` of a
 * `title: { … }` object, or a named function whose identifier is passed there.
 */
function isPaneTitleHook(context: Ctx, fn: FunctionNode): boolean {
  if (isTitleTextProperty(fn.parent)) return true;
  if (fn.type !== AST_NODE_TYPES.FunctionDeclaration || !fn.id) return false;
  const variable = resolveVariable(context, fn.id);
  return (
    variable?.references.some((ref) => {
      const parent = ref.identifier.parent;
      return (
        isTitleTextProperty(parent) &&
        (parent as TSESTree.Property).value === ref.identifier
      );
    }) ?? false
  );
}

/** `undefined` returned by a pane title hook — see the file header. */
function isTitleFallback(
  context: Ctx,
  at: TSESTree.Node,
  pendingValue: TSESTree.Node,
): boolean {
  const n = unwrap(pendingValue);
  if (n.type !== AST_NODE_TYPES.Identifier || n.name !== "undefined") {
    return false;
  }
  const fn = enclosingFunction(at);
  return fn !== null && isPaneTitleHook(context, fn);
}

function isResourceResultBinding(
  context: Ctx,
  ident: TSESTree.Identifier,
): boolean {
  const hook = hookCallOf(context, ident);
  if (!hook || !RESOURCE_HOOKS.has(hook.name)) return false;
  const { name, call } = hook;
  // Carve-out: select-based point reads are sanctioned narrowed reads.
  if (name === "useResource") {
    const opts = call.arguments[2];
    if (
      opts &&
      unwrap(opts).type === AST_NODE_TYPES.ObjectExpression &&
      (unwrap(opts) as TSESTree.ObjectExpression).properties.some(
        (p) =>
          p.type === AST_NODE_TYPES.Property &&
          !p.computed &&
          ((p.key.type === AST_NODE_TYPES.Identifier &&
            p.key.name === "select") ||
            (p.key.type === AST_NODE_TYPES.Literal &&
              p.key.value === "select")),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A test that is TRUE while the result is not ready — `X.pending`, or its
 * `status` spelling `X.status !== "ready"` — as `{ obj, swapped: false }`; its
 * negation (`!X.pending`, `X.status === "ready"`) as `swapped: true`. Null for
 * any other test.
 */
function notReadyTestOf(
  expr: TSESTree.Node,
): { obj: TSESTree.Identifier; swapped: boolean } | null {
  const n = unwrap(expr);
  const pending = pendingAccessOf(n);
  if (pending) return { obj: pending, swapped: false };
  if (n.type === AST_NODE_TYPES.UnaryExpression && n.operator === "!") {
    const inner = pendingAccessOf(n.argument);
    if (inner) return { obj: inner, swapped: true };
    return null;
  }
  if (n.type !== AST_NODE_TYPES.BinaryExpression) return null;
  const negated = n.operator === "!==" || n.operator === "!=";
  if (!negated && n.operator !== "===" && n.operator !== "==") return null;
  const obj = isReadyLiteral(n.right)
    ? statusAccessOf(n.left)
    : isReadyLiteral(n.left)
      ? statusAccessOf(n.right)
      : null;
  return obj ? { obj, swapped: !negated } : null;
}

function isReadyLiteral(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  return n.type === AST_NODE_TYPES.Literal && n.value === "ready";
}

/** Returns the result identifier when `expr` is `<ident>.status`. */
function statusAccessOf(expr: TSESTree.Node): TSESTree.Identifier | null {
  const n = unwrap(expr);
  if (
    n.type === AST_NODE_TYPES.MemberExpression &&
    !n.computed &&
    n.object.type === AST_NODE_TYPES.Identifier &&
    n.property.type === AST_NODE_TYPES.Identifier &&
    n.property.name === "status"
  ) {
    return n.object;
  }
  return null;
}

/** Returns the result identifier when `expr` is `<ident>.pending`. */
function pendingAccessOf(expr: TSESTree.Node): TSESTree.Identifier | null {
  const n = unwrap(expr);
  if (
    n.type === AST_NODE_TYPES.MemberExpression &&
    !n.computed &&
    n.object.type === AST_NODE_TYPES.Identifier &&
    n.property.type === AST_NODE_TYPES.Identifier &&
    n.property.name === "pending"
  ) {
    return n.object;
  }
  return null;
}

export default createRule({
  name: "no-pending-data-collapse",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `result.pending ? <emptyDefault> : result.data` on resource results — it collapses loading into a fake empty state.",
    },
    schema: [],
    messages: {
      pendingCollapse:
        "`{{name}}.pending ? <default> : {{name}}.data` collapses loading into a fake empty/default state — downstream code can no " +
        'longer tell "still loading" from "genuinely empty" (the wrong-state-while-loading bug class). Gate instead: early-return on ' +
        "`.pending`, wrap in <ResourceView>/matchResource(…), combine multiple resources with combineResources(…), or pass `readiness` to " +
        "DataView. See plugins/primitives/plugins/live-state/CLAUDE.md.",
      pendingCollapseReturn:
        "`if ({{name}}.pending) return <typed-empty>` returns a fake empty/default value while loading (or `null` where the settled " +
        "value can be `null` too), then later returns " +
        '`{{name}}.data` — collapsing "still loading" into "genuinely empty" for every caller (the wrong-state-while-loading bug class). ' +
        "This function produces a VALUE, so don't bake a fake-empty into it: expose the raw `ResourceResult` and gate at the caller (for a " +
        "hook/derivation — `mapResource(r, fn)` derives from the settled arm and keeps the pending one), early-return `<Loading/>` (for a component), or combine multiple resources with `combineResources(…)`. " +
        "See plugins/primitives/plugins/live-state/CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ConditionalExpression(node) {
        const test = notReadyTestOf(node.test);
        if (!test) return;
        const { obj } = test;
        const pendingBranch = test.swapped ? node.alternate : node.consequent;
        const dataBranch = test.swapped ? node.consequent : node.alternate;
        if (!isEmptyDefault(context, pendingBranch)) return;
        if (!referencesData(dataBranch, obj.name)) return;
        if (isTitleFallback(context, node, pendingBranch)) return;
        if (!isResourceResultBinding(context, obj)) return;
        context.report({
          node,
          messageId: "pendingCollapse",
          data: { name: obj.name },
        });
      },
      // Statement form: `if (X.pending) return <typed-empty>; … return …X.data…`.
      // Only the DIRECT `if (X.pending)` shape is handled; the inverted
      // `if (!X.pending) { … } return <empty>` form is intentionally NOT covered
      // (rare, and the data-stand-in correlation is harder to assert safely).
      IfStatement(node) {
        const test = notReadyTestOf(node.test);
        if (!test || test.swapped) return;
        const { obj } = test;
        const consReturn = consequentReturn(node.consequent);
        if (!consReturn || !consReturn.argument) return;
        // Locate the subsequent VALUE return so we can structurally compare the
        // pending stand-in against it — findDataReturn also enforces the
        // load-bearing non-JSX guard (component renders are never flagged).
        const fn = enclosingFunction(node);
        if (!fn) return;
        const dataReturn = findDataReturn(fn, obj.name, consReturn);
        if (!dataReturn?.argument) return;
        const typedEmpty = isTypedEmptyStandIn(
          consReturn.argument,
          dataReturn.argument,
          obj.name,
        );
        // A nullish stand-in collapses only when the settled value can be
        // nullish too — see the file header.
        const nullishCollapse =
          isNullishLiteral(consReturn.argument) &&
          canBeNullish(dataReturn.argument);
        if (!typedEmpty && !nullishCollapse) return;
        if (isTitleFallback(context, node, consReturn.argument)) return;
        if (!isResourceResultBinding(context, obj)) return;
        context.report({
          node,
          messageId: "pendingCollapseReturn",
          data: { name: obj.name },
        });
      },
    };
  },
});
