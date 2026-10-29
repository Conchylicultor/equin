import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  ASTUtils,
  AST_NODE_TYPES,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { Scope, SourceCode } from "@typescript-eslint/utils/ts-eslint";

/**
 * no-post-mount-element-type
 *
 * Tripwire for a specific class of bug: a ternary that renders DIFFERENT JSX
 * element TYPES at the same logical position (`<Fragment>` vs `<div>`, or two
 * different host tags / components) gated on a `useState` whose setter is called
 * ONLY inside `useEffect` / `useLayoutEffect` callbacks.
 *
 * React reconciles by element type at a given position. The initial render uses
 * the constant initial state; the post-mount effect flips it; React sees a type
 * change at that position and tears the whole subtree down and rebuilds it —
 * STRUCTURALLY guaranteed, on every single mount. (The just-diagnosed SlotRender
 * remount-amplification bug: `const [horizontal] = useState(false)` flipped by a
 * `useLayoutEffect([])` driving `horizontal ? <div className="flex…"/> :
 * <Fragment/>` → hundreds of DOM nodes destroyed per mount.)
 *
 * The fix is to render ONE stable element and toggle `className`/props instead
 * (e.g. `className={state ? "flex…" : "contents"}`), so React updates in place.
 *
 * This is a NUDGE, not a guarantee. The detection deliberately favors FALSE
 * NEGATIVES over FALSE POSITIVES: a false positive breaks the build (plugin
 * rules run as `error`), whereas a false negative merely misses an evasive case.
 *
 * Three conditions must ALL hold for a report:
 *   (1) Post-mount-only state: a `useState` whose setter has ≥1 call site and
 *       every call site is lexically inside a useEffect/useLayoutEffect callback.
 *       If the setter is ever passed as a value (untraceable) → skip.
 *   (2) Ternary element-type swap: a ConditionalExpression whose `test`
 *       references that state, with consequent/alternate that classify as
 *       DIFFERENT non-null element types.
 *   (3) IDENTICAL, NON-EMPTY children in both branches. The footgun is a
 *       WRAPPER-type swap around the SAME content (`<div…>{kids}</div>` vs
 *       `<Fragment>{kids}</Fragment>`), where the prescribed fix (toggle
 *       className/props on one stable element) actually applies. When the two
 *       branches render DIFFERENT content (loading vs error, plain vs
 *       highlighted) it is legitimate conditional rendering — the children
 *       signatures differ, so we stay silent. Empty children (`<Skeleton/>` vs
 *       `<Content/>`, the common SSR-mount pattern) likewise are not flagged.
 *
 * Scope is TERNARY ONLY. The early-return form (`if (s) return <A/>; …`) is an
 * accepted false negative. If a remount is intended, disable the rule on the
 * line with a reason.
 */

const createRule = lintRuleCreator(import.meta.url);

/** Is this an effect-hook call (useEffect / useLayoutEffect)? */
function isEffectHookCall(node: TSESTree.CallExpression): boolean {
  const name =
    node.callee.type === "Identifier"
      ? node.callee.name
      : node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier"
        ? node.callee.property.name
        : null;
  return name === "useEffect" || name === "useLayoutEffect";
}

/** Simple callee name of a call, member-or-identifier. */
function calleeName(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

/**
 * Is `useState` / `React.useState` (or any other member `.useState`)? Matches by
 * name only — like the sibling rules, detection is structural, not by import
 * resolution.
 */
function isUseStateCall(node: TSESTree.CallExpression): boolean {
  return calleeName(node) === "useState";
}

/**
 * Walk up from a node to test "is this node lexically inside the callback
 * (arguments[0]) of a useEffect/useLayoutEffect call". A setter nested in a
 * listener/observer/`.then()` created INSIDE the effect still resolves here —
 * still post-mount, which is correct.
 */
function isInsideEffectCallback(node: TSESTree.Node): boolean {
  let cur: TSESTree.Node | undefined = node.parent;
  while (cur) {
    if (
      (cur.type === "ArrowFunctionExpression" ||
        cur.type === "FunctionExpression") &&
      cur.parent.type === "CallExpression" &&
      cur.parent.arguments[0] === cur &&
      isEffectHookCall(cur.parent)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

type ElementType =
  | { kind: "fragment" }
  | { kind: "element"; name: string };

/** Stringify a JSX opening-element name (handles member / namespaced forms). */
function stringifyJSXName(name: TSESTree.JSXTagNameExpression): string {
  switch (name.type) {
    case AST_NODE_TYPES.JSXIdentifier:
      return name.name;
    case AST_NODE_TYPES.JSXMemberExpression:
      return `${stringifyJSXName(name.object)}.${name.property.name}`;
    case AST_NODE_TYPES.JSXNamespacedName:
      return `${name.namespace.name}:${name.name.name}`;
    default: {
      const _exhaustive: never = name;
      return String(_exhaustive);
    }
  }
}

/**
 * Classify a ternary branch by its JSX element TYPE. Returns null for anything
 * that isn't a JSX element/fragment (string, identifier, null, nested ternary) —
 * those branches stay silent (favor false negatives).
 */
function elementType(node: TSESTree.Expression): ElementType | null {
  if (node.type === "JSXFragment") return { kind: "fragment" };
  if (node.type === "JSXElement") {
    return { kind: "element", name: stringifyJSXName(node.openingElement.name) };
  }
  return null;
}

/** Do two classified element types differ? */
function elementTypesDiffer(a: ElementType, b: ElementType): boolean {
  if (a.kind !== b.kind) return true;
  if (a.kind === "element" && b.kind === "element") return a.name !== b.name;
  return false; // both fragment
}

/**
 * Structural signature of a branch's CHILDREN, ignoring whitespace-only text.
 * Two branches share a signature iff they wrap the SAME children — which is the
 * defining trait of the footgun (a wrapper-type swap around identical content).
 * When the branches render DIFFERENT content (loading vs error, plain vs
 * highlighted), the signatures differ and the rule stays silent. An empty
 * signature (no real children, e.g. `<Skeleton/>` vs `<Content/>`) is treated as
 * "not the footgun" by the caller.
 */
function childrenSignature(
  node: TSESTree.JSXElement | TSESTree.JSXFragment,
  sourceCode: Readonly<SourceCode>,
): string {
  return node.children
    .filter((c) => !(c.type === "JSXText" && c.value.trim() === ""))
    .map((c) => sourceCode.getText(c).trim())
    .join("");
}

export default createRule({
  name: "no-post-mount-element-type",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow choosing a JSX element TYPE from a post-mount-only useState in " +
        "a ternary — React reconciles by type, so the post-mount flip tears the " +
        "subtree down and rebuilds it on every mount. Render one stable element " +
        "and toggle className/props instead.",
    },
    schema: [],
    messages: {
      postMountElementType:
        "This ternary picks different JSX element TYPES from a useState whose " +
        "setter only runs inside an effect — so the value flips after mount and " +
        "React tears the subtree down and rebuilds it on every mount. Render ONE " +
        "stable element and toggle className/props instead (e.g. " +
        "`className={state ? \"flex…\" : \"contents\"}`). If a remount is truly " +
        "intended, disable this rule on the line with a reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Half 1 collects qualifying post-mount state Variables (by identity).
    // Half 2 runs on Program:exit (after every setter reference is resolved):
    // from each post-mount state it ascends its reads into the enclosing ternary
    // test and classifies the branches by element type.
    const postMountStates = new Set<Scope.Variable>();

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isUseStateCall(node)) return;

        // Parent must be `const [stateId, setterId] = useState(...)`.
        const declarator = node.parent;
        if (
          declarator.type !== "VariableDeclarator" ||
          declarator.id.type !== "ArrayPattern"
        ) {
          return;
        }
        const [stateEl, setterEl] = declarator.id.elements;
        if (
          !stateEl ||
          stateEl.type !== "Identifier" ||
          !setterEl ||
          setterEl.type !== "Identifier"
        ) {
          return;
        }

        const setterVar = ASTUtils.findVariable(
          context.sourceCode.getScope(setterEl),
          setterEl,
        );
        const stateVar = ASTUtils.findVariable(
          context.sourceCode.getScope(stateEl),
          stateEl,
        );
        if (!setterVar || !stateVar) return;

        // Every setter reference must be a call site, and every call site must
        // be inside an effect. A non-call reference (setter passed as a value)
        // is untraceable → skip (favor false negative).
        let callSites = 0;
        for (const ref of setterVar.references) {
          const ident = ref.identifier;
          const parent = ident.parent;
          // The destructuring binding `[, setterId]` appears as a write-only
          // reference (the def); it is not a use of the setter — skip it.
          if (ref.isWrite() && !ref.isRead()) continue;

          const isCallSite =
            parent.type === "CallExpression" && parent.callee === ident;
          if (!isCallSite) {
            // A non-call READ means the setter is passed as a value (untraceable
            // — e.g. `onChange={setX}`) → skip this state (favor false negative).
            return;
          }
          callSites += 1;
          if (!isInsideEffectCallback(ident)) return; // a non-effect call site
        }
        if (callSites === 0) return; // never flips → no remount

        postMountStates.add(stateVar);
      },

      "Program:exit"() {
        if (postMountStates.size === 0) return;

        for (const stateVar of postMountStates) {
          for (const ref of stateVar.references) {
            // Ascend from this read until the parent is a ConditionalExpression
            // and the node is exactly that conditional's `.test` subtree.
            let child: TSESTree.Node = ref.identifier;
            let parent: TSESTree.Node | undefined = child.parent;
            let cond: TSESTree.ConditionalExpression | null = null;
            while (parent) {
              if (parent.type === "ConditionalExpression" && parent.test === child) {
                cond = parent;
                break;
              }
              child = parent;
              parent = parent.parent;
            }
            if (!cond) continue;

            const consequent = elementType(cond.consequent);
            const alternate = elementType(cond.alternate);
            if (!consequent || !alternate) continue;
            if (!elementTypesDiffer(consequent, alternate)) continue;

            // The footgun is a wrapper-type swap around the SAME children. Only
            // report when both branches wrap structurally-identical, non-empty
            // children — otherwise (different content, or empty children) this is
            // legitimate conditional rendering, not a guaranteed remount.
            if (
              cond.consequent.type !== "JSXElement" &&
              cond.consequent.type !== "JSXFragment"
            ) {
              continue;
            }
            if (
              cond.alternate.type !== "JSXElement" &&
              cond.alternate.type !== "JSXFragment"
            ) {
              continue;
            }
            const sig = childrenSignature(cond.consequent, context.sourceCode);
            if (sig === "" || sig !== childrenSignature(cond.alternate, context.sourceCode)) {
              continue;
            }

            context.report({ node: cond, messageId: "postMountElementType" });
          }
        }
      },
    };
  },
});
