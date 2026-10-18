import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-actions-slot
 *
 * A component that takes an `actions` / `rowActions` / `itemActions` prop and
 * renders it in JSX must render it THROUGH `RowActions`
 * (`@plugins/primitives/plugins/row-actions/web`) — the one implementation of a
 * hover-revealed trailing action cluster. Rendering the binding anywhere else
 * (bare in JSX, or inside a `<Clip>` / `<Stack>` / `<Pin>` / `<span>` wrapper)
 * is a second implementation of the cluster, and second implementations diverge:
 * different reveal, different popup-hold, different pointerdown guard, different
 * size — all invisible until a user notices one view behaving unlike another.
 *
 * ## Why this is a DATAFLOW rule and not a class-shape rule
 *
 * Do not "simplify" this into a className scan. Its predecessor,
 * `no-uncoupled-hover-reveal`, asks whether a class string couples `opacity` and
 * `pointer-events`. That question is about the mechanism a duplicate happens to
 * use TODAY, so a duplicate answers it **in place**: the tree's `w-0` action
 * cluster (`<Clip className={open ? "w-auto" : "w-0"}>{actions}</Clip>`) added
 * the coupling, passed, and survived hardened — while still changing layout on
 * reveal, which moved the anchor of any menu opened inside it (`ee2dfe424`, and
 * `research/2026-08-06-global-row-action-anchor-stability.md`). The next
 * duplicate will use tomorrow's mechanism and pass just as easily.
 *
 * The question this rule asks instead — *does the binding reach the primitive?*
 * — is not satisfiable by editing the duplicate. No class edit, no
 * `pointer-events` addition, no rewrite of the wrapper makes
 * `<Clip>{actions}</Clip>` pass. The only way to satisfy it is to render through
 * `RowActions`, which IS deletion of the duplicate. That is the whole point, and
 * it is why the rule ships with **no path allowlist**: an allowlist is exactly
 * the escape hatch that let the previous duplicate live.
 *
 * ## What counts as reaching the primitive
 *
 *   <RowActions pin={null}>{actions}</RowActions>   // ✓ rendered inside it
 *   <Row actions={actions} />                       // ✓ forwarded on to a host
 *   actions={<Sized>{actions}</Sized>}              // ✓ forwarded, wrapped
 *   const trailing = <>{actions}{more}</>           // ✓ composed, not placed
 *   <Clip className={w0}>{actions}</Clip>           // ✗ a placed cluster
 *   <div>{actions}</div>                            // ✗ a placed cluster
 *   <div>{rowActions(row, i)}</div>                 // ✗ ditto, render-prop form
 *
 * The line is PLACEMENT: an element wrapping the render chooses the cluster's
 * box, geometry and reveal, and that is the duplicate. Forwarding and fragment
 * composition choose nothing — the site that finally places the cluster is where
 * the rule bites, and it only ever bites once. `SectionCard`, `SectionHeaderRow`
 * and `detail-sections` pass this way today, having no cluster of their own.
 *
 * ## Bail-outs (deliberate false negatives)
 *
 * Contributed rules run as `error`, so a false positive breaks the build. This
 * matcher therefore favours missing a case over flagging valid code:
 *
 * 1. **Name-based, no type resolution.** Only the three prop names above. A slot
 *    called `trailing` escapes. Accepted: row containers are few, all in
 *    `primitives/`, and adding one is a reviewed act.
 * 2. **Only destructured props.** The binding must come from an `ObjectPattern`
 *    in the enclosing function's PARAMETER list, or from a
 *    `const { actions } = props` whose `props` is a plain parameter of that same
 *    function. A `props.actions` / `node.actions` member render is NOT tracked —
 *    that shape is dominated by actions carried inside data objects (graph nodes,
 *    descriptors), which are not row clusters.
 * 3. **Only child positions.** The identifier must reach the rendered output of a
 *    `JSXExpressionContainer` whose parent is a JSX element or fragment. A
 *    condition (`actions && …`), a call (`actions.setSort()`) or an attribute
 *    value never fires.
 * 4. **Any `<RowActions>` ancestor acquits**, at any depth, even across a nested
 *    callback. Wrapping inside the primitive is fine — the primitive still owns
 *    the reveal on its own outermost node.
 * 5. **Composition is not placement** (see `placesCluster`). A render with no
 *    element ancestor at all, or one under an `actions=`-shaped attribute, is
 *    forwarding or fragment composition, not a cluster. The one hole this leaves:
 *    a fragment stashed in a variable and THEN wrapped
 *    (`const c = <>{actions}</>; <Clip>{c}</Clip>`) — the second site renders `c`,
 *    not an `actions` prop, so it escapes. Closing it needs alias dataflow;
 *    accepted, in the same class as `import { RowActions as X }`.
 * 6. **The primitive is matched by NAME.** `import { RowActions as X }` evades,
 *    and a local component named `RowActions` (the jsonl-viewer one) acquits its
 *    own hosts. Both are accepted: the local one is itself a thin wrapper around
 *    the primitive, and re-aliasing to dodge a lint rule is not accidental code.
 * 7. **Only top-level statements** of a function body are scanned for the
 *    `const { actions } = props` form.
 *
 * A genuinely non-row `actions` slot (a toolbar's, a banner's) escapes by NAME —
 * call it `trailing` — or, if the name is load-bearing, by a per-site
 * `// eslint-disable-next-line row-actions/no-raw-actions-slot -- <reason>`, a
 * marker that travels with the code and is re-reviewed when the code moves. What
 * it must never get is a path entry as an `exempt/index.ts` path entry.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** Prop names that denote a trailing action cluster on a row / card / table row. */
const ACTIONS_PROP_NAMES = new Set(["actions", "rowActions", "itemActions"]);

/** The one component every such cluster must render through. */
const PRIMITIVE_NAME = "RowActions";

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

function isFunctionNode(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/**
 * Every expression that can reach the rendered output of a JSX child container,
 * unwrapping only the VALUE-SELECTING forms. `cond && x` contributes `x` but not
 * `cond`, so `{actions && <Foo/>}` is a condition on `actions`, not a render of
 * it. Anything else terminates the walk (deliberate false negative).
 */
function collectRenderedExpressions(
  expr: TSESTree.Node | null | undefined,
  out: TSESTree.Node[],
): void {
  if (!expr) return;
  if (expr.type === "ConditionalExpression") {
    collectRenderedExpressions(expr.consequent, out);
    collectRenderedExpressions(expr.alternate, out);
    return;
  }
  if (expr.type === "LogicalExpression") {
    // `a && b` / `a ?? b` / `a || b` — only the right operand is rendered for
    // `&&`; for `||`/`??` either side can be, so take both.
    if (expr.operator !== "&&") collectRenderedExpressions(expr.left, out);
    collectRenderedExpressions(expr.right, out);
    return;
  }
  if (
    expr.type === "TSAsExpression" ||
    expr.type === "TSNonNullExpression" ||
    expr.type === "TSSatisfiesExpression"
  ) {
    collectRenderedExpressions(expr.expression, out);
    return;
  }
  if (expr.type === "ArrayExpression") {
    for (const element of expr.elements)
      collectRenderedExpressions(element, out);
    return;
  }
  out.push(expr);
}

/**
 * The `actions`-shaped prop key this identifier is bound to, or `null` if the
 * identifier is not a destructured prop of any enclosing function.
 *
 * Handles the renamed form (`{ itemActions: acts }` → looked up by the VALUE
 * name `acts`, reported against the KEY `itemActions`), so aliasing the local
 * binding is not an escape.
 */
function actionsPropKeyFor(identifier: TSESTree.Identifier): string | null {
  const localName = identifier.name;

  for (
    let node: TSESTree.Node | undefined = identifier.parent;
    node;
    node = node.parent
  ) {
    if (!isFunctionNode(node)) continue;

    // (a) destructured directly in the parameter list — `({ actions }) => …`
    for (const param of node.params) {
      const pattern = param.type === "AssignmentPattern" ? param.left : param;
      const key = actionsKeyInPattern(pattern, localName);
      if (key) return key;
    }

    // (b) `const { actions } = props;` where `props` is a plain parameter of
    // this same function.
    const body = node.body;
    if (body.type !== "BlockStatement") continue;
    for (const statement of body.body) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const declarator of statement.declarations) {
        const init = declarator.init;
        if (init?.type !== "Identifier") continue;
        const fromParam = node.params.some(
          (p) => p.type === "Identifier" && p.name === init.name,
        );
        if (!fromParam) continue;
        const key = actionsKeyInPattern(declarator.id, localName);
        if (key) return key;
      }
    }
  }
  return null;
}

/**
 * The `actions`-shaped key of `pattern` that binds the local name `localName`,
 * or `null`. Only the pattern's own top-level properties are considered — a
 * nested destructure is a nested object, not a prop.
 */
function actionsKeyInPattern(
  pattern: TSESTree.Node,
  localName: string,
): string | null {
  if (pattern.type !== "ObjectPattern") return null;
  for (const property of pattern.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : null;
    if (!key || !ACTIONS_PROP_NAMES.has(key)) continue;
    // `{ actions }`, `{ actions: acts }`, `{ actions = null }`.
    const value =
      property.value.type === "AssignmentPattern"
        ? property.value.left
        : property.value;
    if (value.type === "Identifier" && value.name === localName) return key;
  }
  return null;
}

/** Is this JSX element `<RowActions …>` (bare or `Ns.RowActions`)? */
function isPrimitiveElement(element: TSESTree.JSXElement): boolean {
  const name = element.openingElement.name;
  if (name.type === "JSXIdentifier") return name.name === PRIMITIVE_NAME;
  if (name.type === "JSXMemberExpression")
    return name.property.name === PRIMITIVE_NAME;
  return false;
}

/** Is this attribute one of the `actions`-shaped slots (i.e. a forward)? */
function isActionsAttribute(attribute: TSESTree.JSXAttribute): boolean {
  return (
    attribute.name.type === "JSXIdentifier" &&
    ACTIONS_PROP_NAMES.has(attribute.name.name)
  );
}

/**
 * Does this render site PLACE a cluster (as opposed to reaching the primitive or
 * merely composing/forwarding one)? Walks the full ancestor chain and stops at
 * the first thing that settles the question:
 *
 *  - a `<RowActions>` ancestor          → reaches the primitive. Not a placement.
 *  - an `actions=` / `rowActions=` /
 *    `itemActions=` attribute ancestor  → forwarded on to a host that owns the
 *                                         cluster, even wrapped in chrome
 *                                         (`actions={<ControlSizeProvider>{actions}
 *                                         </ControlSizeProvider>}`, as SectionCard
 *                                         does). Not a placement.
 *  - otherwise                          → a placement IFF some plain JSX element
 *                                         wraps the render.
 *
 * That last clause is what separates PLACING a cluster from COMPOSING one. A
 * render whose only JSX ancestors are fragments (`const trailing = <>{actions}
 * {moreMenu}</>`, the tree's row-chrome) decides nothing about where the cluster
 * sits — something downstream still has to place it, and that site is where the
 * rule bites. Wrap the same render in ONE element (`<Clip>{actions}</Clip>`) and
 * you have chosen its box, its geometry and its reveal: that is the duplicate.
 */
function placesCluster(node: TSESTree.Node): boolean {
  let wrapped = false;
  for (
    let current: TSESTree.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    if (current.type === "JSXElement") {
      if (isPrimitiveElement(current)) return false;
      wrapped = true;
      continue;
    }
    if (current.type === "JSXAttribute" && isActionsAttribute(current)) {
      return false;
    }
  }
  return wrapped;
}

export default createRule({
  name: "no-raw-actions-slot",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an actions/rowActions/itemActions prop to reach the RowActions primitive — " +
        "rendered inside <RowActions> or forwarded on as an actions= attribute. Rendering it " +
        "raw (bare, or inside a Clip/Stack/Pin/span wrapper) hand-rolls a second row-action cluster.",
    },
    schema: [],
    messages: {
      rawActionsSlot:
        "`{{prop}}` is rendered raw — this hand-rolls a second row-action cluster, which will " +
        "diverge from every other one (reveal, popup-hold, pointerdown guard, size). Render it " +
        "through the primitive: `<RowActions pin={…}>{{{prop}}}</RowActions>` from " +
        "@plugins/primitives/plugins/row-actions/web (placement axes: pin right | top-right | null, " +
        "alwaysVisible, float — see plugins/primitives/plugins/row-actions/CLAUDE.md), or forward " +
        "it on as an `actions={…}` attribute to a host that does. There is no allowlist: this rule " +
        "asks whether the binding REACHES the primitive, so no edit to the wrapper can satisfy it.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXExpressionContainer(node: TSESTree.JSXExpressionContainer) {
        // (1) Child position only. An attribute value (`actions={actions}`) is
        // the sanctioned forwarding form and is never a render.
        const parent = node.parent;
        if (
          !parent ||
          (parent.type !== "JSXElement" && parent.type !== "JSXFragment")
        ) {
          return;
        }

        // (2) What actually reaches the rendered output of this container.
        const rendered: TSESTree.Node[] = [];
        collectRenderedExpressions(node.expression, rendered);

        for (const expression of rendered) {
          // The binding itself (`{actions}`) or its RENDER-PROP form
          // (`{rowActions(row, index)}`, which is how data-table's slot is
          // spelled). Both are a render of the same slot.
          const identifier =
            expression.type === "Identifier"
              ? expression
              : expression.type === "CallExpression" &&
                  expression.callee.type === "Identifier"
                ? expression.callee
                : null;
          if (!identifier) continue;

          // (3) …and is a destructured `actions`-shaped prop of an enclosing
          // function (by key, so an alias is not an escape).
          const prop = actionsPropKeyFor(identifier);
          if (!prop) continue;

          // (4) The dataflow question: does this render PLACE a cluster, or does
          // it reach the primitive / forward on / merely compose?
          if (!placesCluster(identifier)) continue;

          context.report({
            node: identifier,
            messageId: "rawActionsSlot",
            data: { prop },
          });
        }
      },
    };
  },
});
