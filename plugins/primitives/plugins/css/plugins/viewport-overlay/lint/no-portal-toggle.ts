import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A portal is a POSITIONING mechanism, not a mount-retention one — and code that
 * puts one behind a condition is almost always reaching for the second thing.
 *
 * React reconciles a portal by the identity of its container:
 * `reconcileSinglePortal` reuses the existing fiber only when the current child
 * is already a `HostPortal` with the same `containerInfo`. So a portal that
 * appears, disappears, or changes container at one tree position DELETES its
 * subtree and builds a new one — losing every scroll offset, uncommitted edit,
 * Web Audio node and loaded `<iframe>` inside it, silently.
 *
 * Two real sites shipped this belief, in two different spellings, which is why
 * the rule catches three:
 *
 *   1. `cond ? createPortal(…) : <div/>`         — a ternary at one position;
 *   2. `if (!on) return <>{children}</>;` then
 *      `return createPortal(…)`                   — the same thing across returns,
 *                                                   which a ternary-only rule misses;
 *   3. `createPortal(children, cond ? a : b)`     — the container itself changing.
 *
 * `… : null` / `return null` stay VALID: a genuine mount/unmount is an honest
 * intent, not a broken keep-alive claim. The check is deliberately shallow — it
 * classifies the branch expression itself (a `createPortal` call, possibly
 * wrapped in a fragment), never a portal buried somewhere inside a JSX subtree —
 * so an ordinary conditional that happens to contain an overlay is untouched.
 *
 * Real keep-alive is one of two things, neither a branch: remove whatever made
 * the portal necessary (drop the ancestor's `transform`, as
 * `apps-core/surface` does), or portal unconditionally into ONE stable container
 * and re-parent that container imperatively (`primitives/adaptive-bar`).
 * Measured in `web/__tests__/portal-toggle-remounts.test.tsx`.
 */

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/**
 * Peel wrappers that change nothing about what React sees at this position: a
 * `as`/`satisfies`/`!` cast, and a fragment (or element) whose only meaningful
 * child is a single `{expression}`. `<>{createPortal(…)}</>` is a portal, and
 * `<>{children}</>` is whatever `children` is.
 */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return unwrap(node.expression);
  }
  if (node.type === "JSXFragment" || node.type === "JSXElement") {
    const meaningful = node.children.filter(
      (child) => !(child.type === "JSXText" && child.value.trim() === ""),
    );
    const only = meaningful[0];
    if (
      meaningful.length === 1 &&
      only?.type === "JSXExpressionContainer" &&
      only.expression.type !== "JSXEmptyExpression"
    ) {
      return unwrap(only.expression);
    }
  }
  return node;
}

/** `createPortal(…)` or `ReactDOM.createPortal(…)` — however it was imported. */
function isPortalCall(node: TSESTree.Node): node is TSESTree.CallExpression {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name === "createPortal";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "createPortal"
  );
}

/**
 * "Renders nothing" — the honest other half of a mount/unmount. Anything else
 * (an element, a fragment with content, an identifier, a call) is a REPLACEMENT
 * for the portal, which is what deletes the subtree.
 */
function rendersNothing(node: TSESTree.Node): boolean {
  if (node.type === "Literal")
    return node.value === null || node.value === false;
  return node.type === "Identifier" && node.name === "undefined";
}

type Branch = "portal" | "nothing" | "other";

function classify(node: TSESTree.Node): Branch {
  const inner = unwrap(node);
  if (isPortalCall(inner)) return "portal";
  if (rendersNothing(inner)) return "nothing";
  return "other";
}

export default createRule({
  name: "no-portal-toggle",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a conditional createPortal — a portal that appears, disappears, or changes container at one tree position remounts its subtree, so it can never be a keep-alive seam.",
    },
    schema: [],
    messages: {
      portalToggle:
        "Conditional `createPortal`: this remounts the subtree. React reconciles a " +
        "portal by container identity, so swapping a portal for a non-portal at one " +
        "tree position deletes the subtree and builds a new one — every scroll " +
        "offset, uncommitted edit and loaded `<iframe>` inside it is lost. If you " +
        "meant a genuine mount/unmount, return `null` on the other path. If you " +
        "meant to KEEP the subtree alive, a branch cannot do it: either remove what " +
        "made the portal necessary (drop the ancestor's transform/filter, as " +
        "`apps-core/surface` does), or portal unconditionally into one stable " +
        "container and re-parent that container imperatively (`primitives/adaptive-bar`).",
      portalContainer:
        "Conditional `createPortal` container: this remounts the subtree. React " +
        "reuses a portal's fiber only when `containerInfo` is the same node, so " +
        "changing the container argument deletes the subtree and builds a new one. " +
        "Portal into ONE stable container and move that container with plain DOM " +
        "calls React never sees (`primitives/adaptive-bar`), or accept the remount " +
        "explicitly by rendering `null` on the other path.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Spelling 2 is a whole-function property, so returns are accumulated and
    // judged at Program:exit rather than one statement at a time.
    const returnsByFunction = new Map<
      TSESTree.Node,
      { portal: TSESTree.ReturnStatement[]; other: TSESTree.ReturnStatement[] }
    >();

    function enclosingFunction(node: TSESTree.Node): TSESTree.Node | null {
      let cur: TSESTree.Node | undefined = node.parent;
      while (cur) {
        if (FUNCTION_TYPES.has(cur.type)) return cur;
        cur = cur.parent;
      }
      return null;
    }

    return {
      // Spelling 1 — a ternary holding a portal on one side and a real element
      // on the other.
      ConditionalExpression(node) {
        const consequent = classify(node.consequent);
        const alternate = classify(node.alternate);
        if (
          (consequent === "portal" && alternate === "other") ||
          (alternate === "portal" && consequent === "other")
        ) {
          context.report({ node, messageId: "portalToggle" });
        }
      },

      // Spelling 3 — the container argument itself is a choice. `??`/`||` count:
      // a fallback container is still a container that can change.
      CallExpression(node) {
        if (!isPortalCall(node)) return;
        const container = node.arguments[1];
        if (!container) return;
        const inner = unwrap(container);
        if (
          inner.type === "ConditionalExpression" ||
          inner.type === "LogicalExpression"
        ) {
          context.report({ node: container, messageId: "portalContainer" });
        }
      },

      ReturnStatement(node) {
        const fn = enclosingFunction(node);
        if (!fn) return;
        const branch = node.argument ? classify(node.argument) : "nothing";
        if (branch === "nothing") return;
        let entry = returnsByFunction.get(fn);
        if (!entry) {
          entry = { portal: [], other: [] };
          returnsByFunction.set(fn, entry);
        }
        entry[branch === "portal" ? "portal" : "other"].push(node);
      },

      "Program:exit"() {
        for (const { portal, other } of returnsByFunction.values()) {
          // One report per function, on the portal return — the path whose
          // subtree the other path throws away.
          const first = portal[0];
          if (first && other.length > 0) {
            context.report({ node: first, messageId: "portalToggle" });
          }
        }
      },
    };
  },
});
