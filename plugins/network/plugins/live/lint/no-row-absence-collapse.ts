import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-row-absence-collapse
 *
 * A by-id row read (`useLive(c, { id })` → `LiveRowResult`) answers four
 * things: loading, failed, found, and not found. "Not found" is an answer —
 * the row was deleted, or never existed — and a surface that treats it as
 * "not loaded yet" spins forever (the agent side pane, the review pane over a
 * deleted conversation). Two spellings lose it:
 *
 * - **A value reduction** — the read reduced to one nullable value in which
 *   loading and absent come out the same, so no caller can tell them apart:
 *   - `X.status === "ready" && X.found ? <value> : null | undefined`;
 *   - `return X.found ? <value> : null | undefined` in a function whose loading arm
 *     of `X` — a `case "loading":` of `switch (X.status)`, or
 *     `if (X.status === "loading" | X.status !== "ready") return …` —
 *     returns a `null` / `undefined` literal too.
 *   Only a non-JSX `<value>` is flagged: a component rendering nothing in both
 *   arms makes a render choice; a hook or helper handing `T | null` onwards
 *   erases the arm for everyone downstream. The one sanctioned spelling of
 *   the reduction is `rowOrStale` (live/web; its file is exempt), for a
 *   surface that renders the same truthful thing either way.
 *
 * - **Absent drawn as loading** — a `<Loading>` rendered on the not-found
 *   arm: the consequent of `!X.found` (or the alternate of `X.found ? … :`),
 *   or, in a ready callback (`<ResourceView>`'s child function,
 *   `matchResource` / `foldResource`'s `ready`), the consequent of a falsy
 *   test of its data parameter (`!p`, `p === null`, `p == null`,
 *   `p === undefined`): the read has answered, and a `mapRow` that turned
 *   "absent" into `null` does not make it loading.
 *
 * Fix: hand the `LiveRowResult` (or `mapRow`'s `ResourceResult`) onwards and
 * render each arm — `RowView` (live/web) takes a required `missing`.
 */

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFunction(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  );
}

function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.type === AST_NODE_TYPES.TSAsExpression ||
    n.type === AST_NODE_TYPES.TSNonNullExpression ||
    n.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    n = n.expression;
  }
  return n;
}

function isNullish(node: TSESTree.Node | null | undefined): boolean {
  if (!node) return false;
  const n = unwrap(node);
  return (
    (n.type === AST_NODE_TYPES.Literal && n.value === null) ||
    (n.type === AST_NODE_TYPES.Identifier && n.name === "undefined")
  );
}

function isJsx(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  return (
    n.type === AST_NODE_TYPES.JSXElement ||
    n.type === AST_NODE_TYPES.JSXFragment
  );
}

/** `<obj>.<prop>` with `obj` an identifier: the identifier's name, else null. */
function memberOf(node: TSESTree.Node, prop: string): string | null {
  const n = unwrap(node);
  if (
    n.type === AST_NODE_TYPES.MemberExpression &&
    !n.computed &&
    n.object.type === AST_NODE_TYPES.Identifier &&
    n.property.type === AST_NODE_TYPES.Identifier &&
    n.property.name === prop
  ) {
    return n.object.name;
  }
  return null;
}

function isStringLiteral(node: TSESTree.Node, value: string): boolean {
  const n = unwrap(node);
  return n.type === AST_NODE_TYPES.Literal && n.value === value;
}

/** `X.status <op> "<value>"` (either side): X's name, else null. */
function statusCompare(
  node: TSESTree.Node,
  ops: readonly string[],
  value: string,
): string | null {
  const n = unwrap(node);
  if (n.type !== AST_NODE_TYPES.BinaryExpression || !ops.includes(n.operator))
    return null;
  if (isStringLiteral(n.right, value)) return memberOf(n.left, "status");
  if (isStringLiteral(n.left, value)) return memberOf(n.right, "status");
  return null;
}

/**
 * The read a `found` test is about, and whether it also gates on readiness
 * (`X.status === "ready" && X.found`): `X.found`, `X.found === true`, or that
 * conjunction.
 */
function foundTestOf(
  test: TSESTree.Node,
): { name: string; readyGated: boolean } | null {
  const n = unwrap(test);
  const direct = memberOf(n, "found");
  if (direct) return { name: direct, readyGated: false };
  if (n.type === AST_NODE_TYPES.LogicalExpression && n.operator === "&&") {
    const right = memberOf(n.right, "found");
    if (right && statusCompare(n.left, ["===", "=="], "ready") === right) {
      return { name: right, readyGated: true };
    }
  }
  return null;
}

/** `!X.found` / `X.found === false`: X's name, else null. */
function notFoundTestOf(test: TSESTree.Node): string | null {
  const n = unwrap(test);
  if (n.type === AST_NODE_TYPES.UnaryExpression && n.operator === "!") {
    return memberOf(n.argument, "found");
  }
  if (
    n.type === AST_NODE_TYPES.BinaryExpression &&
    (n.operator === "===" || n.operator === "==") &&
    unwrap(n.right).type === AST_NODE_TYPES.Literal &&
    (unwrap(n.right) as TSESTree.Literal).value === false
  ) {
    return memberOf(n.left, "found");
  }
  return null;
}

function forEachChild(
  node: TSESTree.Node,
  visit: (child: TSESTree.Node) => void,
): void {
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    const items = Array.isArray(child) ? child : [child];
    for (const c of items) {
      if (
        typeof c === "object" &&
        c !== null &&
        typeof (c as { type?: unknown }).type === "string"
      ) {
        visit(c as TSESTree.Node);
      }
    }
  }
}

/** Does the subtree (nested functions excluded) render a `<Loading>`? */
function rendersLoading(node: TSESTree.Node): boolean {
  if (
    node.type === AST_NODE_TYPES.JSXOpeningElement &&
    node.name.type === AST_NODE_TYPES.JSXIdentifier &&
    node.name.name === "Loading"
  ) {
    return true;
  }
  if (isFunction(node)) return false;
  let found = false;
  forEachChild(node, (c) => {
    if (!found && rendersLoading(c)) found = true;
  });
  return found;
}

function enclosingFunction(node: TSESTree.Node): FunctionNode | null {
  let n = node.parent;
  while (n) {
    if (isFunction(n)) return n;
    n = n.parent;
  }
  return null;
}

/** The single returned expression of a statement (a bare return, or a block's only one). */
function returned(stmt: TSESTree.Statement): TSESTree.Expression | null {
  if (stmt.type === AST_NODE_TYPES.ReturnStatement) return stmt.argument;
  if (
    stmt.type === AST_NODE_TYPES.BlockStatement &&
    stmt.body.length === 1 &&
    stmt.body[0]?.type === AST_NODE_TYPES.ReturnStatement
  ) {
    return stmt.body[0].argument;
  }
  return null;
}

/**
 * Does `fn` (its own body, nested functions excluded) answer `name`'s loading
 * arm with a `null` / `undefined` literal?
 */
function loadingArmIsNullish(fn: FunctionNode, name: string): boolean {
  let hit = false;
  const walk = (node: TSESTree.Node, top: boolean) => {
    if (hit) return;
    if (!top && isFunction(node)) return;
    if (
      node.type === AST_NODE_TYPES.SwitchStatement &&
      memberOf(node.discriminant, "status") === name
    ) {
      const cases = node.cases;
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i]!;
        if (!c.test || !isStringLiteral(c.test, "loading")) continue;
        // Fall through empty cases to the first one with a body.
        let j = i;
        while (j < cases.length && cases[j]!.consequent.length === 0) j++;
        const body = cases[j]?.consequent[0];
        if (body && body.type === AST_NODE_TYPES.ReturnStatement) {
          if (isNullish(body.argument)) hit = true;
        }
      }
    }
    if (node.type === AST_NODE_TYPES.IfStatement) {
      const loading =
        statusCompare(node.test, ["===", "=="], "loading") === name ||
        statusCompare(node.test, ["!==", "!="], "ready") === name;
      const value = loading ? returned(node.consequent) : null;
      if (loading && value !== null && isNullish(value)) hit = true;
    }
    forEachChild(node, (c) => walk(c, false));
  };
  if (fn.body) walk(fn.body, true);
  return hit;
}

/** Is `node` the function's returned value (a `return` argument, or an arrow's expression body)? */
function isReturned(node: TSESTree.Node): boolean {
  let n: TSESTree.Node = node;
  while (
    n.parent &&
    (n.parent.type === AST_NODE_TYPES.TSAsExpression ||
      n.parent.type === AST_NODE_TYPES.TSNonNullExpression)
  ) {
    n = n.parent;
  }
  const parent = n.parent;
  return (
    parent?.type === AST_NODE_TYPES.ReturnStatement ||
    (parent?.type === AST_NODE_TYPES.ArrowFunctionExpression &&
      parent.body === n)
  );
}

/** Is `fn` a ready callback, and if so the name of its data parameter? */
function readyCallbackParam(fn: FunctionNode): string | null {
  const param = fn.params[0];
  if (!param || param.type !== AST_NODE_TYPES.Identifier) return null;
  const parent = fn.parent;
  // <ResourceView …>{(data) => …}</ResourceView>
  if (
    parent?.type === AST_NODE_TYPES.JSXExpressionContainer &&
    parent.parent?.type === AST_NODE_TYPES.JSXElement
  ) {
    const name = parent.parent.openingElement.name;
    if (
      name.type === AST_NODE_TYPES.JSXIdentifier &&
      name.name === "ResourceView"
    ) {
      return param.name;
    }
  }
  // matchResource / foldResource(r, { ready: (data) => … })
  if (
    parent?.type === AST_NODE_TYPES.Property &&
    !parent.computed &&
    parent.key.type === AST_NODE_TYPES.Identifier &&
    parent.key.name === "ready" &&
    parent.parent?.type === AST_NODE_TYPES.ObjectExpression &&
    parent.parent.parent?.type === AST_NODE_TYPES.CallExpression
  ) {
    const callee = parent.parent.parent.callee;
    if (
      callee.type === AST_NODE_TYPES.Identifier &&
      (callee.name === "matchResource" || callee.name === "foldResource")
    ) {
      return param.name;
    }
  }
  return null;
}

/** `!p`, `p === null`, `p == null`, `p === undefined`: is `test` a falsy test of `name`? */
function isAbsentTestOf(test: TSESTree.Node, name: string): boolean {
  const n = unwrap(test);
  if (n.type === AST_NODE_TYPES.UnaryExpression && n.operator === "!") {
    const arg = unwrap(n.argument);
    return arg.type === AST_NODE_TYPES.Identifier && arg.name === name;
  }
  if (
    n.type === AST_NODE_TYPES.BinaryExpression &&
    (n.operator === "===" || n.operator === "==")
  ) {
    const [a, b] = [unwrap(n.left), unwrap(n.right)];
    return (
      (a.type === AST_NODE_TYPES.Identifier &&
        a.name === name &&
        isNullish(b)) ||
      (b.type === AST_NODE_TYPES.Identifier && b.name === name && isNullish(a))
    );
  }
  return false;
}

export default createRule({
  name: "no-row-absence-collapse",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow folding a by-id row read's not-found arm into its loading arm — a nullable value both come out as, or a <Loading> drawn for an absent row.",
    },
    schema: [],
    messages: {
      valueCollapse:
        "`{{name}}` is a by-id row read: this reduces it to one value that is `null`/`undefined` both while it loads and when there is " +
        "no such row, so nothing downstream can tell a deleted row from a slow one (a spinner forever). Hand the `LiveRowResult` " +
        "(or `mapRow(…)`'s ResourceResult) onwards and render each arm — `RowView` takes a required `missing` — or, where the surface " +
        "renders the same truthful thing either way (a body under a pane resolve guard, a title with a fallback), use `rowOrStale` " +
        "(live/web).",
      absentAsLoading:
        "The read has answered that there is no such row, and this draws it as loading — a spinner that never ends once the row is " +
        "deleted. Render the not-found arm as its own state (`RowView`'s required `missing`).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ConditionalExpression(node) {
        // Absent drawn as loading: `X.found ? … : <Loading/>`, `!X.found ? <Loading/> : …`.
        const found = foundTestOf(node.test);
        const notFound = notFoundTestOf(node.test);
        if (
          (found && rendersLoading(node.alternate)) ||
          (notFound && rendersLoading(node.consequent))
        ) {
          context.report({ node, messageId: "absentAsLoading" });
          return;
        }
        // Value reduction.
        if (!found || isJsx(node.consequent) || !isNullish(node.alternate))
          return;
        if (!found.readyGated) {
          // Only as what the function hands back: there the loading arm's
          // `return null` and this one meet in one value.
          if (!isReturned(node)) return;
          const fn = enclosingFunction(node);
          if (!fn || !loadingArmIsNullish(fn, found.name)) return;
        }
        context.report({
          node,
          messageId: "valueCollapse",
          data: { name: found.name },
        });
      },
      IfStatement(node) {
        if (notFoundTestOf(node.test) && rendersLoading(node.consequent)) {
          context.report({ node, messageId: "absentAsLoading" });
          return;
        }
        const fn = enclosingFunction(node);
        const param = fn ? readyCallbackParam(fn) : null;
        if (
          param &&
          isAbsentTestOf(node.test, param) &&
          rendersLoading(node.consequent)
        ) {
          context.report({ node, messageId: "absentAsLoading" });
        }
      },
    };
  },
});
