import {
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * A primitive with an open passthrough has promised its callers ONE node:
 * everything they spread lands there, `ref` hands that same node back, and it
 * is still the same node tomorrow. This rule is what makes the promise true
 * inside the component body.
 *
 * The bug it exists for is not hypothetical and not rare. `Row` accepted an
 * open bag, spread it on "the rendered element", and rendered one element until
 * the day a caller passed `actions` — from then on a box wrapping a synthesized
 * `<button>`. So a `data-*` a caller used as a selector target moved from the
 * row box to the button, at a call site nobody edited, with no throw, no type
 * error and no test failure. `ViewportOverlay` shipped the other half of the
 * same defect: `ref={rootRef}` written AFTER `{...rest}`, which silently
 * discards the caller's ref.
 *
 * ## Counting elements is the wrong measure
 *
 * The tempting rule is "a primitive with a passthrough must render one
 * element". It is wrong in both directions: `Badge` and `OverlayPanel` render
 * two apiece and are correct, and `Row` rendered one and was wrong. What
 * matters is whether the bag and `ref` name the same node. That reframing is
 * what makes growth safe: wrapping `<Surface ref={ref} {...rest}>` in a new
 * outer `<div>` keeps them together and is fine; moving `ref` to the new
 * wrapper and leaving `{...rest}` on the inner element splits them, and that
 * exact shape is what this rule rejects.
 *
 * ## How it finds its subjects
 *
 * Through the TYPE CHECKER, not by matching `extends Passthrough` in the file:
 * the props parameter's type is asked for a string index signature
 * (`getStringIndexType()`). That is deliberate. `TabProps` is declared in
 * `ui/tab-bar/core/types.ts` while its three implementations live in three
 * other plugins, and a syntactic match would see none of them. Any props type
 * that is open — however it got that way — is in scope.
 *
 * The syntactic half of the gate: the props parameter is an object pattern
 * containing a rest element, and the function is named like a component (a
 * capitalised name). The name test keeps the rule off ordinary helpers that
 * happen to take an open record; its cost is that an anonymous inline component
 * (`memo(({ …rest }: Props) => …)`) is not seen.
 *
 * ## What the rest binding may do
 *
 * - **`restEscaped`** — the bag may only be spread as JSX, handed to
 *   `splitPassthrough` as its first argument, or asked for ONE named key
 *   (`rest.role`, the way `ToggleChip` checks whether the caller supplied a
 *   role before adding `aria-pressed`). `Object.entries(rest)`,
 *   `const props = { ...rest }`, `helper(rest)`, `rest[key]` in a loop —
 *   anything that derives from the bag by hand — puts the destination beyond
 *   what any reader (or this rule) can follow. That hand-rolled loop is
 *   literally how `Row` routed, and `splitPassthrough` is the same loop with
 *   the split NAMED.
 * - **`restFannedOut`** — one bag, one element. Spread onto a second element it
 *   is no longer a promise about one node, and duplicate `id`s / duplicate
 *   handlers are the visible symptom. Only spreads that can render TOGETHER
 *   count: `Row` returns one tree per path and spreads the bag in both, which
 *   is one destination written twice (see `mutuallyExclusive`).
 * - **`restOffRef`** — when the component destructures `ref`, the element
 *   receiving the bag must carry a `ref` attribute. This is the historical bug
 *   as a fingerprint: `ref` on an outer wrapper, `{...rest}` on an inner
 *   element.
 * - **`anchoredOffRef`** — `splitPassthrough`'s `anchored` half is the part that
 *   keeps the promise, so it is held to the same two conditions: on the `ref`
 *   element, exactly once. `routed` is deliberately unconstrained — naming it IS
 *   the statement that it goes to a second, deliberate destination.
 *
 * When `ref` is NOT destructured there is nothing to check: React 19 treats
 * `ref` as an ordinary prop, so it rides inside the bag and lands wherever the
 * bag lands. Co-location is automatic, which is why `Badge` (no `ref`
 * destructured, one `{...rest}`) is correct as written. The same reasoning
 * gates `anchoredOffRef`'s ref condition: with no `ref` binding, `ref` travels
 * in `anchored` unless the primitive's own predicate routes it away.
 *
 * ## What it checks about `ref`, and what it does not
 *
 * PRESENCE of a `ref` attribute on the receiving element, never its expression.
 * `OverlayPanel` writes `ref={panelRef}` where `panelRef` is a `useCallback`
 * composing the caller's ref with the scroll-fade and rail-guard refs — that is
 * correct, and deciding so from the syntax alone is not possible. A rule that
 * demanded the literal destructured identifier would reject every primitive
 * that has internal refs of its own, which is most of them.
 *
 * ## Accepted false negatives
 *
 * - A bag spread onto a COMPONENT that renders no DOM node swallows it
 *   silently, and no syntactic rule can see that.
 *   `trigger-render-safety/no-provider-trigger-render` covers the closest
 *   instance of that class (a provider as a base-ui `render` root).
 * - JSX assembled in a helper function outside the component body: the rest
 *   binding cannot reach it without tripping `restEscaped`, so the bag is safe,
 *   but a `ref` placed there is invisible here.
 * - Two spreads separated by a nested callback (one in the returned tree, one
 *   inside a `render` prop) read as two different rendered outputs, so they are
 *   not counted as a fan-out.
 * - A props type opened through an inherited type rather than `Passthrough`.
 *   The checker still sees it — that is the point of using the checker — but
 *   `no-anonymous-passthrough` cannot nudge at the declaration site.
 */

type Variable = TSESLint.Scope.Variable;

/**
 * The name a component is known by. A function declaration carries its own; an
 * arrow is named by the `const` it is assigned to. Anything else (an inline
 * `memo(...)` argument, a default-exported anonymous function) has no name to
 * test, and is skipped.
 */
function componentName(
  fn:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
): string | undefined {
  if (fn.type === "FunctionDeclaration") return fn.id?.name;
  const parent = fn.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  return undefined;
}

/** The non-computed key of an object-pattern property, when it has a plain one. */
function propertyKeyName(prop: TSESTree.Property): string | undefined {
  if (prop.computed) return undefined;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
    return prop.key.value;
  }
  return undefined;
}

/** Does this object pattern destructure a property called `ref`? */
function destructuresRef(pattern: TSESTree.ObjectPattern): boolean {
  return pattern.properties.some(
    (p) => p.type === "Property" && propertyKeyName(p) === "ref",
  );
}

/** The JSX element receiving a spread carries a `ref=` attribute of its own. */
function elementHasRefAttribute(spread: TSESTree.JSXSpreadAttribute): boolean {
  return spread.parent.attributes.some(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === "ref",
  );
}

/**
 * The rendered output a node belongs to: its enclosing `return`, or the arrow
 * function itself when the body is an expression. A component renders exactly
 * one of these, so two spreads under different ones never appear together.
 */
function renderRoot(node: TSESTree.Node): TSESTree.Node | undefined {
  let current: TSESTree.Node | undefined = node.parent;
  while (current) {
    if (current.type === "ReturnStatement") return current;
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression" ||
      current.type === "FunctionDeclaration"
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** Root-first chain of ancestors, ending at `node` itself. */
function pathFromRoot(node: TSESTree.Node): TSESTree.Node[] {
  const chain: TSESTree.Node[] = [];
  let current: TSESTree.Node | undefined = node;
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  return chain.reverse();
}

/**
 * Can these two spreads never be rendered together?
 *
 * `Row` is why this exists: it returns one tree for the plain path and another
 * for the split path, and spreads the bag in BOTH. That is one bag on one node,
 * written twice — not a fan-out — and a rule that counted occurrences in the
 * source would have called the correct implementation wrong.
 *
 * Two shapes count as exclusive: different rendered outputs (different
 * `return`s), and opposite arms of the same `if` / ternary / `switch`. `a && b`
 * deliberately does not count — both sides render.
 */
function mutuallyExclusive(a: TSESTree.Node, b: TSESTree.Node): boolean {
  if (renderRoot(a) !== renderRoot(b)) return true;
  const pathA = pathFromRoot(a);
  const pathB = pathFromRoot(b);
  let depth = 0;
  while (
    depth < pathA.length &&
    depth < pathB.length &&
    pathA[depth] === pathB[depth]
  ) {
    depth++;
  }
  const fork = pathA[depth - 1];
  const branchA = pathA[depth];
  const branchB = pathB[depth];
  if (!fork || !branchA || !branchB) return false;
  // An if-chain rather than a `switch`, because `fork` is the whole
  // `TSESTree.Node` union: `switch-exhaustiveness-check` wants every one of its
  // ~150 members listed, and a `default` does not satisfy it. The rules that DO
  // switch on a node type (trigger-render-safety, element-type-safety) switch on
  // `JSXTagNameExpression`, a three-member union where that is reachable.
  if (fork.type === "ConditionalExpression" || fork.type === "IfStatement") {
    return (
      (branchA === fork.consequent && branchB === fork.alternate) ||
      (branchA === fork.alternate && branchB === fork.consequent)
    );
  }
  if (fork.type === "SwitchStatement") {
    return branchA.type === "SwitchCase" && branchB.type === "SwitchCase";
  }
  return false;
}

/**
 * The spreads that genuinely fan the bag out: every one that can be rendered
 * alongside an earlier one. The first spread of a set is never an offender —
 * the report belongs on the copy that made it a second destination.
 */
function fanOutOffenders(
  spreads: TSESTree.JSXSpreadAttribute[],
): Set<TSESTree.JSXSpreadAttribute> {
  const offenders = new Set<TSESTree.JSXSpreadAttribute>();
  for (const [index, later] of spreads.entries()) {
    for (const earlier of spreads.slice(0, index)) {
      if (!mutuallyExclusive(earlier, later)) {
        offenders.add(later);
        break;
      }
    }
  }
  return offenders;
}

/**
 * A read of ONE named key off the bag — `rest.role`, `rest["role"]`.
 *
 * `ToggleChip` is the reason this is allowed: it asks whether the caller
 * supplied a `role` before deciding to add `aria-pressed` of its own. That
 * inspects the bag; it does not divert it, and the bag is still spread whole
 * onto one element afterwards.
 *
 * A DYNAMIC key (`rest[key]` inside a loop) is not a named read — that is the
 * hand-rolled routing this rule exists to stop — and writing INTO the bag
 * (`rest.role = "tab"`) is not a read at all. Both stay reported.
 */
function isNamedKeyRead(
  id: TSESTree.Node,
  member: TSESTree.MemberExpression,
): boolean {
  if (member.object !== id) return false;
  const named =
    !member.computed ||
    (member.property.type === "Literal" &&
      typeof member.property.value === "string");
  if (!named) return false;
  const parent = member.parent;
  const isTarget =
    (parent.type === "AssignmentExpression" && parent.left === member) ||
    (parent.type === "UpdateExpression" && parent.argument === member) ||
    (parent.type === "UnaryExpression" && parent.operator === "delete");
  return !isTarget;
}

/** `splitPassthrough(bag, isRouted)` — the one sanctioned way to derive. */
function isSplitPassthroughCall(call: TSESTree.CallExpression): boolean {
  return (
    call.callee.type === "Identifier" && call.callee.name === "splitPassthrough"
  );
}

/**
 * The variable a binding identifier declares, looked up among the variables the
 * declaring node introduces. Matching on the DEF rather than the name is what
 * keeps a shadowed binding from resolving to the outer one.
 */
function declaredVariable(
  variables: readonly Variable[],
  id: TSESTree.Identifier,
): Variable | undefined {
  return variables.find((v) => v.defs.some((d) => d.name === id));
}

export default createRule({
  name: "no-unanchored-passthrough",
  meta: {
    type: "problem",
    docs: {
      description:
        "An open props passthrough is a promise about ONE node: the bag a caller spreads and the `ref` it holds must land on the same element. Rejects a rest binding that escapes into hand-rolled derivation, is spread onto more than one element, or is spread onto an element other than the one carrying `ref`.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      restEscaped:
        "`{{rest}}` is `{{component}}`'s open passthrough, and deriving from it by hand puts its " +
        "destination beyond what a reader — or this rule — can follow. (Asking it for one named key, " +
        "`{{rest}}.someProp`, is fine — that inspects the bag without diverting it.) Spread it as JSX " +
        "on the element that carries `ref`. If part of it genuinely belongs on a second node, say so " +
        "by name: " +
        "`const { anchored, routed } = splitPassthrough({{rest}}, isRoutedKey)` from " +
        "`@plugins/primitives/plugins/passthrough/core` — `anchored` stays on the `ref` element, " +
        "`routed` is the half you are declaring goes elsewhere. Last resort: " +
        "// eslint-disable-next-line passthrough/no-unanchored-passthrough -- <reason>.",
      restFannedOut:
        "`{{rest}}` is spread onto more than one element in `{{component}}`, so a caller's `id`, " +
        "`data-*` and handlers are duplicated and the passthrough no longer names one node. Spread the " +
        "bag once, on the element `ref` points at; route the part that belongs on the other node with " +
        "`splitPassthrough({{rest}}, isRoutedKey)`. Last resort: " +
        "// eslint-disable-next-line passthrough/no-unanchored-passthrough -- <reason>.",
      restOffRef:
        "`{{component}}` hands out `ref` but spreads `{{rest}}` on an element that has no `ref` of its " +
        "own, so a caller's attributes and the node they hold are two different elements — the `Row` " +
        "bug exactly. Put `ref` on the element receiving the bag (compose it with any internal refs " +
        "through a `useCallback`, the way `OverlayPanel` does), or move the bag to the element that " +
        "already carries `ref`. Last resort: " +
        "// eslint-disable-next-line passthrough/no-unanchored-passthrough -- <reason>.",
      anchoredOffRef:
        "`{{anchored}}` is the ANCHORED half of `{{component}}`'s passthrough — the part that keeps " +
        "the promise — and it {{detail}}. It must land on the element carrying `ref`, exactly once; " +
        "`routed` is the half that is allowed to go elsewhere, which is what naming it says. Last " +
        "resort: // eslint-disable-next-line passthrough/no-unanchored-passthrough -- <reason>.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Every .ts/.tsx in this repo resolves to type info (the type-check worker
    // supplies a pre-built program; the IDE uses projectService), so the
    // services are always type-aware here.
    const services = ESLintUtils.getParserServices(context);
    const sourceCode = context.sourceCode;

    /**
     * Every JSX spread of `variable`, plus a report for any other use of it.
     * Three shapes are allowed through: a JSX spread attribute, the first
     * argument of `splitPassthrough`, and a read of one named key. `onEscape`
     * decides what to do with everything else — the anchored binding has no
     * sanctioned second use, so it passes `undefined` and simply collects.
     */
    function collectSpreads(
      variable: Variable,
      onEscape: ((id: TSESTree.Node) => void) | undefined,
    ): {
      spreads: TSESTree.JSXSpreadAttribute[];
      splitCalls: TSESTree.CallExpression[];
    } {
      const spreads: TSESTree.JSXSpreadAttribute[] = [];
      const splitCalls: TSESTree.CallExpression[] = [];
      for (const reference of variable.references) {
        const id = reference.identifier;
        // The binding's own declaration is not a use of it.
        if (variable.defs.some((d) => d.name === id)) continue;
        const parent = id.parent;
        if (parent.type === "JSXSpreadAttribute" && parent.argument === id) {
          spreads.push(parent);
          continue;
        }
        if (
          parent.type === "CallExpression" &&
          parent.arguments[0] === id &&
          isSplitPassthroughCall(parent)
        ) {
          splitCalls.push(parent);
          continue;
        }
        if (parent.type === "MemberExpression" && isNamedKeyRead(id, parent)) {
          continue;
        }
        onEscape?.(id);
      }
      return { spreads, splitCalls };
    }

    /**
     * The identifier `splitPassthrough`'s `anchored` result is bound to,
     * including the aliased form `{ anchored: boxProps, routed: controlProps }`.
     */
    function anchoredBinding(
      call: TSESTree.CallExpression,
    ):
      | { id: TSESTree.Identifier; declarator: TSESTree.VariableDeclarator }
      | undefined {
      const declarator = call.parent;
      if (
        declarator.type !== "VariableDeclarator" ||
        declarator.id.type !== "ObjectPattern"
      ) {
        return undefined;
      }
      for (const prop of declarator.id.properties) {
        if (prop.type !== "Property") continue;
        if (propertyKeyName(prop) !== "anchored") continue;
        if (prop.value.type !== "Identifier") continue;
        return { id: prop.value, declarator };
      }
      return undefined;
    }

    function checkComponent(
      fn:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression,
    ): void {
      // (1) Syntactic gate — a named-like-a-component function whose first
      //     parameter destructures a rest bag. Cheap, and it runs first so the
      //     checker is only consulted for realistic candidates.
      const name = componentName(fn);
      if (!name || !/^[A-Z]/.test(name)) return;
      const param = fn.params[0];
      if (!param || param.type !== "ObjectPattern") return;
      const restElement = param.properties.find(
        (p): p is TSESTree.RestElement => p.type === "RestElement",
      );
      if (!restElement || restElement.argument.type !== "Identifier") return;
      const restId = restElement.argument;

      // (2) TYPE gate — the props type is OPEN. Asked of the checker rather
      //     than matched syntactically, so a props type declared in another
      //     plugin (`TabProps`) is seen from its implementations.
      const propsType = services.getTypeAtLocation(param);
      if (propsType.getStringIndexType() === undefined) return;

      const hasRefBinding = destructuresRef(param);
      const fnVariables = sourceCode.getDeclaredVariables(fn);
      const restVar = declaredVariable(fnVariables, restId);
      if (!restVar) return;

      const { spreads, splitCalls } = collectSpreads(restVar, (id) => {
        context.report({
          node: id,
          messageId: "restEscaped",
          data: { rest: restId.name, component: name },
        });
      });

      // One bag, one element — but only among spreads that can render TOGETHER
      // (see `mutuallyExclusive`: two return paths spreading the same bag are
      // one destination written twice).
      for (const spread of fanOutOffenders(spreads)) {
        context.report({
          node: spread,
          messageId: "restFannedOut",
          data: { rest: restId.name, component: name },
        });
      }

      // The bag lands where `ref` points. Only checkable when the component
      // destructures `ref`: otherwise `ref` rides inside the bag itself and is
      // co-located by construction.
      if (hasRefBinding) {
        for (const spread of spreads) {
          if (elementHasRefAttribute(spread)) continue;
          context.report({
            node: spread,
            messageId: "restOffRef",
            data: { rest: restId.name, component: name },
          });
        }
      }

      // The anchored half of a declared split is held to the same two
      // conditions as the bag it came from.
      for (const call of splitCalls) {
        const anchored = anchoredBinding(call);
        if (!anchored) continue;
        const anchoredVar = declaredVariable(
          sourceCode.getDeclaredVariables(anchored.declarator),
          anchored.id,
        );
        if (!anchoredVar) continue;
        const { spreads: anchoredSpreads } = collectSpreads(
          anchoredVar,
          undefined,
        );
        const fannedOut = fanOutOffenders(anchoredSpreads);
        for (const spread of anchoredSpreads) {
          const detail = fannedOut.has(spread)
            ? "is spread onto more than one element"
            : hasRefBinding && !elementHasRefAttribute(spread)
              ? "is spread onto an element that carries no `ref`"
              : undefined;
          if (!detail) continue;
          context.report({
            node: spread,
            messageId: "anchoredOffRef",
            data: { anchored: anchored.id.name, component: name, detail },
          });
        }
      }
    }

    return {
      FunctionDeclaration: checkComponent,
      FunctionExpression: checkComponent,
      ArrowFunctionExpression: checkComponent,
    };
  },
});
