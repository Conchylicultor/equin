import {
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Disclosure content must fold with motion.
 *
 * The collapsible primitive animates its content (`FoldMotion`, and
 * `CollapsibleContent` over it): a close keeps the box mounted until its
 * fold-away has run. A hand-rolled `{open && <Body/>}` mounts and unmounts the
 * same content in one frame — no motion, and nothing says so. The disclosure
 * state hands out a boolean, so the gate was the easy spelling; this rule makes
 * it the wrong one.
 *
 * WHAT IS A DISCLOSURE BOOLEAN — every source is local data flow, no types:
 *
 *   1. `open` from `useCollapsible()` / `useCollapsibleContext()` — destructured
 *      (`const { open } = useCollapsible()`) or read off the result
 *      (`c.open`, `ctx?.open`).
 *   2. `expanded.has(…)` where `expanded` comes from `useExpandAll()`.
 *   3. Whatever a DISCLOSURE TRIGGER reports: the expression in an
 *      `aria-expanded={…}` (or a `<CollapsibleChevron open={…}>`) — its local
 *      variables, and its member reads (`row.expanded`) within that component.
 *      An element that also carries `aria-haspopup` opens a popup (a menu, a
 *      listbox, a dialog), not a disclosure, and is skipped: that content is a
 *      portal with its own motion, not a fold.
 *
 * WHAT IS FLAGGED — a JSX conditional whose test reads a disclosure boolean:
 *   `x && <…>`, `a && x && <…>`, `!x && <…>`, `x && xs.map((i) => <…>)`,
 *   `x ? <…> : null`, `x ? <A/> : <B/>` (a swap: each side should fold).
 *
 * Also flagged: a native `<details>` — the browser's own disclosure, which
 * opens and closes in one frame (and draws its own marker, not the chevron).
 *
 * NOT SEEN (accepted false negatives): an early `if (!open) return …`, and a
 * toggle that reports its state nowhere — no `aria-expanded`, no chevron. Such
 * a toggle is an accessibility bug of its own; giving it `useCollapsible`'s
 * trigger props brings it under this rule.
 *
 * WHAT IS NOT — a conditional INSIDE the trigger itself (an element with
 * `aria-expanded`, a spread `triggerProps` / `triggerControlProps`, or a
 * `<CollapsibleTrigger>`): a chevron or a "Hide"/"View" label swap is the
 * trigger's own chrome, never the content it discloses.
 *
 * A genuine exception (content whose unmount must be instant) is declared by
 * the plugin that owns the file, in its `exempt/index.ts`.
 */

type MessageIds = "unanimatedDisclosure" | "nativeDetails";

const HOOKS_WITH_OPEN = new Set(["useCollapsible", "useCollapsibleContext"]);
const TRIGGER_SPREADS = new Set(["triggerProps", "triggerControlProps"]);

type FnNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFn(node: TSESTree.Node): node is FnNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** The outermost function enclosing `node` — the component, for a render
 *  callback nested inside it. */
function outermostFn(node: TSESTree.Node): FnNode | null {
  let found: FnNode | null = null;
  for (let n: TSESTree.Node | undefined = node.parent; n; n = n.parent) {
    if (isFn(n)) found = n;
  }
  return found;
}

function isJsx(node: TSESTree.Node): boolean {
  return node.type === "JSXElement" || node.type === "JSXFragment";
}

/** The expression renders markup: JSX, or a list of it (`xs.map((x) => <X/>)`). */
function yieldsJsx(node: TSESTree.Node): boolean {
  if (isJsx(node)) return true;
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.property.type !== "Identifier" ||
    (node.callee.property.name !== "map" &&
      node.callee.property.name !== "flatMap")
  ) {
    return false;
  }
  const fn = node.arguments[0];
  if (
    !fn ||
    (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")
  ) {
    return false;
  }
  if (fn.body.type !== "BlockStatement") return isJsx(fn.body);
  return fn.body.body.some(
    (st) =>
      st.type === "ReturnStatement" &&
      st.argument != null &&
      isJsx(st.argument),
  );
}

function calleeName(
  node: TSESTree.Expression | null | undefined,
): string | null {
  if (!node || node.type !== "CallExpression") return null;
  const c = node.callee;
  if (c.type === "Identifier") return c.name;
  return null;
}

function attr(
  el: TSESTree.JSXOpeningElement,
  name: string,
): TSESTree.JSXAttribute | undefined {
  return el.attributes.find(
    (a): a is TSESTree.JSXAttribute =>
      a.type === "JSXAttribute" &&
      a.name.type === "JSXIdentifier" &&
      a.name.name === name,
  );
}

function elementName(el: TSESTree.JSXOpeningElement): string | null {
  if (el.name.type === "JSXIdentifier") return el.name.name;
  if (el.name.type === "JSXMemberExpression") return el.name.property.name;
  return null;
}

/** The element is a disclosure trigger: its children are the trigger's own
 *  chrome, never the content it discloses. */
function isTriggerElement(el: TSESTree.JSXOpeningElement): boolean {
  if (attr(el, "aria-expanded")) return true;
  if (elementName(el) === "CollapsibleTrigger") return true;
  return el.attributes.some((a) => {
    if (a.type !== "JSXSpreadAttribute") return false;
    const arg = a.argument;
    if (arg.type === "Identifier") return TRIGGER_SPREADS.has(arg.name);
    return (
      arg.type === "MemberExpression" &&
      arg.property.type === "Identifier" &&
      TRIGGER_SPREADS.has(arg.property.name)
    );
  });
}

function insideTrigger(node: TSESTree.Node): boolean {
  for (let n: TSESTree.Node | undefined = node.parent; n; n = n.parent) {
    if (n.type === "JSXElement" && isTriggerElement(n.openingElement)) {
      return true;
    }
  }
  return false;
}

/** Strip `!`, parentheses-free by AST, and TS non-null wrappers. */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  for (;;) {
    if (n.type === "UnaryExpression" && n.operator === "!") n = n.argument;
    else if (n.type === "TSNonNullExpression") n = n.expression;
    else if (n.type === "ChainExpression") n = n.expression;
    else return n;
  }
}

function isEmptyBranch(node: TSESTree.Node): boolean {
  return (
    (node.type === "Literal" &&
      (node.value === null || node.value === false || node.value === "")) ||
    (node.type === "Identifier" && node.name === "undefined")
  );
}

export default createRule<[], MessageIds>({
  name: "no-unanimated-disclosure",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disclosure content gated on an open/expanded boolean must fold through FoldMotion / CollapsibleContent, never mount and unmount in one frame.",
    },
    schema: [],
    messages: {
      unanimatedDisclosure:
        "`{{test}}` gates disclosure content with no fold motion — it mounts and unmounts in one frame. " +
        "Render the content through the collapsible primitive instead: `<FoldMotion {...contentProps}>` " +
        "(contentProps from useCollapsible), `<CollapsibleContent>` under a <Collapsible>, or " +
        "`<FoldMotion open={…}>` when the open state lives elsewhere (padding and borders go on a box INSIDE it). " +
        "See plugins/primitives/plugins/collapsible/CLAUDE.md.",
      nativeDetails:
        "A native `<details>` opens and closes in one frame, with the browser's own marker. Use " +
        "<Collapsible> + <CollapsibleTrigger> (with a <CollapsibleChevron>) + <CollapsibleContent>, which fold with motion.",
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    /** Variables holding a disclosure boolean. */
    const openVars = new Set<TSESLint.Scope.Variable>();
    /** Variables holding a useCollapsible / useCollapsibleContext result. */
    const collapsibleObjs = new Set<TSESLint.Scope.Variable>();
    /** Variables holding useExpandAll's `expanded` set. */
    const expandedSets = new Set<TSESLint.Scope.Variable>();
    /** Variables holding a whole useExpandAll result. */
    const expandAllObjs = new Set<TSESLint.Scope.Variable>();
    /** Member reads a trigger reports (`row.expanded`), per component. */
    const openMembers = new Map<FnNode | null, Set<string>>();
    const candidates: { node: TSESTree.Node; test: TSESTree.Node }[] = [];

    function declared(id: TSESTree.Identifier): TSESLint.Scope.Variable | null {
      return (
        sourceCode
          .getDeclaredVariables(id.parent as TSESTree.Node)
          .find((v) => v.name === id.name) ?? null
      );
    }

    function resolve(id: TSESTree.Identifier): TSESLint.Scope.Variable | null {
      let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(id);
      while (scope) {
        const ref = scope.references.find((r) => r.identifier === id);
        if (ref) return ref.resolved;
        const v = scope.set.get(id.name);
        if (v) return v;
        scope = scope.upper;
      }
      return null;
    }

    /** The variables a destructured property's value pattern binds. */
    function variablesOfPattern(
      decl: TSESTree.VariableDeclarator,
      pattern: TSESTree.Node,
    ): TSESLint.Scope.Variable[] {
      const target =
        pattern.type === "AssignmentPattern" ? pattern.left : pattern;
      if (target.type !== "Identifier") return [];
      return sourceCode
        .getDeclaredVariables(decl)
        .filter((v) => v.name === target.name);
    }

    /** `const { open, expanded } = useX()` / `const c = useX()`. */
    function recordHookBinding(node: TSESTree.VariableDeclarator) {
      const hook = calleeName(node.init);
      if (!hook) return;
      const isCollapsible = HOOKS_WITH_OPEN.has(hook);
      const isExpandAll = hook === "useExpandAll";
      if (!isCollapsible && !isExpandAll) return;
      if (node.id.type === "Identifier") {
        const v = declared(node.id);
        if (v) (isCollapsible ? collapsibleObjs : expandAllObjs).add(v);
        return;
      }
      if (node.id.type !== "ObjectPattern") return;
      for (const p of node.id.properties) {
        if (p.type !== "Property" || p.key.type !== "Identifier") continue;
        if (isCollapsible && p.key.name === "open") {
          for (const v of variablesOfPattern(node, p.value)) openVars.add(v);
        }
        if (isExpandAll && p.key.name === "expanded") {
          for (const v of variablesOfPattern(node, p.value))
            expandedSets.add(v);
        }
      }
    }

    /** What a disclosure trigger reports becomes a disclosure boolean. */
    function recordTriggerState(
      expr: TSESTree.Node,
      el: TSESTree.JSXOpeningElement,
    ) {
      const fn = outermostFn(el);
      const visit = (n: TSESTree.Node) => {
        if (isFn(n)) return;
        if (n.type === "Identifier") {
          const v = resolve(n);
          // Only component-local state: a module constant or an import is not
          // this component's open flag.
          if (v && v.scope.type !== "module" && v.scope.type !== "global") {
            openVars.add(v);
          }
          return;
        }
        if (n.type === "MemberExpression") {
          const set = openMembers.get(fn) ?? new Set<string>();
          set.add(sourceCode.getText(n));
          openMembers.set(fn, set);
          return;
        }
        // `gate ? open : undefined` / `gate && open` report `open`, not the
        // gate: only the value a branch yields is the expanded state.
        if (n.type === "ConditionalExpression") {
          visit(n.consequent);
          visit(n.alternate);
        } else if (n.type === "LogicalExpression") {
          if (n.operator !== "&&") visit(n.left);
          visit(n.right);
        } else if (n.type === "UnaryExpression") {
          visit(n.argument);
        } else if (
          n.type === "TSNonNullExpression" ||
          n.type === "ChainExpression" ||
          n.type === "TSAsExpression"
        ) {
          visit(n.expression);
        }
      };
      visit(expr);
    }

    /** The disclosure read in `test`, as written — or null if it reads none. */
    function disclosureRead(test: TSESTree.Node): TSESTree.Node | null {
      const n = unwrap(test);
      if (n.type === "LogicalExpression") {
        return disclosureRead(n.left) ?? disclosureRead(n.right);
      }
      if (n.type === "Identifier") {
        const v = resolve(n);
        return v && openVars.has(v) ? n : null;
      }
      if (n.type === "MemberExpression") {
        const members = openMembers.get(outermostFn(n));
        if (members?.has(sourceCode.getText(n))) return n;
        if (
          n.property.type === "Identifier" &&
          n.property.name === "open" &&
          n.object.type === "Identifier"
        ) {
          const v = resolve(n.object);
          if (v && collapsibleObjs.has(v)) return n;
        }
        return null;
      }
      if (
        n.type === "CallExpression" &&
        n.callee.type === "MemberExpression" &&
        n.callee.property.type === "Identifier" &&
        n.callee.property.name === "has"
      ) {
        const obj = n.callee.object;
        if (obj.type === "Identifier") {
          const v = resolve(obj);
          if (v && expandedSets.has(v)) return n;
        }
        if (
          obj.type === "MemberExpression" &&
          obj.property.type === "Identifier" &&
          obj.property.name === "expanded" &&
          obj.object.type === "Identifier"
        ) {
          const v = resolve(obj.object);
          if (v && expandAllObjs.has(v)) return n;
        }
      }
      return null;
    }

    return {
      VariableDeclarator: recordHookBinding,
      JSXOpeningElement(el) {
        if (el.name.type === "JSXIdentifier" && el.name.name === "details") {
          context.report({ node: el, messageId: "nativeDetails" });
        }
        const expanded = attr(el, "aria-expanded");
        if (
          expanded?.value?.type === "JSXExpressionContainer" &&
          expanded.value.expression.type !== "JSXEmptyExpression" &&
          !attr(el, "aria-haspopup")
        ) {
          recordTriggerState(expanded.value.expression, el);
        }
        if (elementName(el) === "CollapsibleChevron") {
          const open = attr(el, "open");
          if (
            open?.value?.type === "JSXExpressionContainer" &&
            open.value.expression.type !== "JSXEmptyExpression"
          ) {
            recordTriggerState(open.value.expression, el);
          }
        }
      },
      LogicalExpression(node) {
        // The outermost `&&` of a chain only: `a && open && <X/>` once.
        if (node.operator !== "&&" || !yieldsJsx(node.right)) return;
        candidates.push({ node, test: node.left });
      },
      ConditionalExpression(node) {
        const markup = yieldsJsx(node.consequent)
          ? node.alternate
          : yieldsJsx(node.alternate)
            ? node.consequent
            : null;
        if (!markup || (!yieldsJsx(markup) && !isEmptyBranch(markup))) return;
        candidates.push({ node, test: node.test });
      },
      // Sources are recorded anywhere in the file (a trigger may sit after the
      // content it discloses), so the candidates are judged at the end.
      "Program:exit"() {
        for (const { node, test } of candidates) {
          if (insideTrigger(node)) continue;
          const read = disclosureRead(test);
          if (!read) continue;
          context.report({
            node,
            messageId: "unanimatedDisclosure",
            data: { test: sourceCode.getText(read) },
          });
        }
      },
    };
  },
});
