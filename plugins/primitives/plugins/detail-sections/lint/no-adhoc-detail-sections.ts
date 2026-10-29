import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-adhoc-detail-sections
 *
 * Tripwire for the hand-rolled detail-pane host: rendering a `.Section.Render`
 * slot and painting the per-section card yourself —
 *
 *   <WorkflowsDetail.Section.Render>
 *     {(s) => (
 *       <Surface level="raised" as="section" className="p-lg">   // <-- flagged
 *         <Text as="h2">{s.title}</Text>
 *         <s.component definitionId={definitionId} />
 *       </Surface>
 *     )}
 *   </WorkflowsDetail.Section.Render>
 *
 * A detail pane is ONE render slot whose sections are contributions, with the
 * HOST owning the chrome — that is what `defineDetailSections`
 * (`@plugins/primitives/plugins/detail-sections/web`) exists to give you:
 * uniform `SectionCard` chrome, persisted per-section open state, an icon /
 * actions / summary header, and a `useAvailable` gate, none of which a
 * hand-rolled host has. Before this rule existed the repo accumulated FIVE
 * independent reinventions of that card, two of them literal copy-paste of each
 * other (deploy → workflows), plus eight task sections that hand-rolled their
 * own `Collapsible` + header INSIDE a host that painted nothing. Hand-rolling is
 * lint-clean and cheaper in the moment, so nothing pushed an author toward the
 * primitive. This rule fires at authoring time and redirects.
 *
 * Detection is NAME-BASED, with NO import or type resolution — same philosophy
 * as `no-adhoc-row-list`. Contributed rules run as `error`, so a false positive
 * BREAKS THE BUILD; the matcher therefore favors FALSE NEGATIVES. In particular
 * a callback that returns a NAMED HELPER which wraps the card two calls deeper
 * (Sonata's old `{(s) => <Section section={s}/>}` → `SectionCardHost` →
 * `SectionCard`) is deliberately NOT flagged.
 *
 * Fires when ALL hold (see create()):
 *   (1) A JSX element whose tag is `<Something>.Section.Render` — the member
 *       immediately before `.Render` is literally `Section`. This one predicate
 *       does most of the work: the repo has dozens of other `.Render` hosts
 *       (`FloatingAction`, `Hud`, `Transport`, `HeaderActions`, `App`, …) and
 *       none of them are section stacks.
 *   (2) It has a children render-prop — a `JSXExpressionContainer` child whose
 *       expression is an arrow/function expression.
 *   (3) Some RETURNED expression of that callback resolves — after unwrapping
 *       ternaries, `&&`, and `as` casts — to a `JSXElement` whose opening name
 *       is the bare identifier `Surface`, `Card`, or `SectionCard`.
 *
 * Verified against the slots that legitimately are NOT detail-section stacks and
 * must never trip it: `website.section` and `home.section` pass no callback at
 * all (fails (2)); `pages.welcome.section` returns `<s.component/>` and
 * `profiling.section` returns a plain `<div>` (both fail (3)); the
 * `ui/variant-region` hosts use `defineSlot`'s `.Region`, never `.Render`
 * (fails (1)).
 */

const createRule = lintRuleCreator(import.meta.url);

/** Card-chrome elements that mark the callback as painting its own section card. */
const CARD_ELEMENTS = new Set(["Surface", "Card", "SectionCard"]);

/**
 * Is `name` the tag `<X.Section.Render>` (or `<A.B.Section.Render>`)? The member
 * IMMEDIATELY before `.Render` must be `Section`, so `<Toolbar.Start.Render>` and
 * `<Foo.Section>` are both untouched.
 */
function isSectionRenderTag(name: TSESTree.JSXTagNameExpression): boolean {
  if (name.type !== "JSXMemberExpression") return false;
  if (name.property.name !== "Render") return false;
  const owner = name.object;
  return owner.type === "JSXMemberExpression" && owner.property.name === "Section";
}

/**
 * The children render-prop of a JSX element: the first `{(item) => …}` child.
 * Whitespace-only `JSXText` children are skipped, so formatting never hides it.
 */
function findRenderProp(
  node: TSESTree.JSXElement,
): TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression | null {
  for (const child of node.children) {
    if (child.type !== "JSXExpressionContainer") continue;
    const expr = child.expression;
    if (
      expr.type === "ArrowFunctionExpression" ||
      expr.type === "FunctionExpression"
    ) {
      return expr;
    }
  }
  return null;
}

/**
 * Collect the return-argument expressions of the render callback: the arrow's
 * expression body directly, or every `ReturnStatement` argument reachable in the
 * block WITHOUT descending into a nested function scope (a nested function's
 * returns belong to that function, not to this callback). Mirrors the identical
 * walk in `data-view`'s `no-adhoc-row-list`.
 */
function collectReturnedExpressions(
  cb: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
): TSESTree.Node[] {
  if (cb.body.type !== "BlockStatement") return [cb.body];

  const out: TSESTree.Node[] = [];
  const walk = (node: TSESTree.Node): void => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return; // a nested function scope — its returns are not ours
    }
    if (node.type === "ReturnStatement" && node.argument) {
      out.push(node.argument);
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) {
            walk(child as TSESTree.Node);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        walk(value as TSESTree.Node);
      }
    }
  };
  walk(cb.body);
  return out;
}

/**
 * Resolve a returned expression to the concrete `JSXElement`s it may evaluate
 * to, unwrapping only the value-SELECTING wrappers: a `ConditionalExpression`
 * (both branches), a `LogicalExpression` (the right operand), and TS casts.
 * Crucially we do NOT descend into a JSXElement's children — a wrapper that
 * merely CONTAINS a Card resolves to the wrapper, so it is a deliberate false
 * negative rather than a flagged bespoke composition.
 */
function resolveJsxElements(
  expr: TSESTree.Node,
  out: TSESTree.JSXElement[],
): void {
  if (expr.type === "JSXElement") {
    out.push(expr);
  } else if (expr.type === "ConditionalExpression") {
    resolveJsxElements(expr.consequent, out);
    resolveJsxElements(expr.alternate, out);
  } else if (expr.type === "LogicalExpression") {
    resolveJsxElements(expr.right, out);
  } else if (
    expr.type === "TSAsExpression" ||
    expr.type === "TSNonNullExpression"
  ) {
    resolveJsxElements(expr.expression, out);
  }
  // Anything else terminates the walk (deliberate false negative).
}

/** Is `el`'s opening tag a bare `Surface` / `Card` / `SectionCard` identifier? */
function isCardElement(el: TSESTree.JSXElement): boolean {
  const name = el.openingElement.name;
  return name.type === "JSXIdentifier" && CARD_ELEMENTS.has(name.name);
}

export default createRule({
  name: "no-adhoc-detail-sections",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled detail-pane section hosts (a `.Section.Render` whose " +
        "callback paints its own Surface/Card/SectionCard). Route the pane through " +
        "the defineDetailSections factory, which owns the section chrome.",
    },
    schema: [],
    messages: {
      adhocDetailSections:
        "Hand-rolled detail-section chrome is banned — a detail pane is ONE render slot " +
        "whose sections are contributions, with the HOST owning the card. Use " +
        "`defineDetailSections(\"<id>\")` from " +
        "@plugins/primitives/plugins/detail-sections/web and render `<X.Host {...entityProps}/>`; " +
        "sections then get uniform SectionCard chrome, persisted open state, and " +
        "icon/actions/summary/useAvailable for free (see " +
        "plugins/primitives/plugins/detail-sections/CLAUDE.md). Pick the factory id so the " +
        "emitted `<id>.section` reproduces the existing slot id, or every user's persisted " +
        "section order resets. If this genuinely is not a section stack (a landing band, a Gantt " +
        "lane), add `// eslint-disable-next-line detail-sections/no-adhoc-detail-sections -- <reason>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXElement(node: TSESTree.JSXElement) {
        // (1) `<X.Section.Render>` — cheapest filter first.
        if (!isSectionRenderTag(node.openingElement.name)) return;

        // (2) A children render-prop, or there is no per-item chrome to inspect.
        const cb = findRenderProp(node);
        if (!cb) return;

        // (3) A returned root that is card chrome. Reported on that element (not
        // on the `.Render` tag) so a `// eslint-disable-next-line … -- <reason>`
        // sits directly above the chrome it exempts, inside the callback's
        // parens, rather than needing `{/* … */}` in JSX-children position.
        for (const returned of collectReturnedExpressions(cb)) {
          const elements: TSESTree.JSXElement[] = [];
          resolveJsxElements(returned, elements);
          for (const el of elements) {
            if (isCardElement(el)) {
              context.report({
                node: el.openingElement.name,
                messageId: "adhocDetailSections",
              });
            }
          }
        }
      },
    };
  },
});
