import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * `<Column scrollBody={false}>` wraps its `body` in a plain BLOCK div
 * (`<div className="min-h-0 flex-1">`), NOT a flex container. The `fill` prop on
 * the layout primitives (`Scroll` / `Clip` / a nested `Column`) only emits the
 * flex-child pair `min-h-0 flex-1`, which does something ONLY inside a flex
 * parent. Inside that block wrapper `fill` is inert: the child gets
 * `height: auto`, grows to its full content height, and any `overflow` never
 * engages — silently breaking scrolling.
 *
 * This rule flags the exact shape: a `<Column>` with `scrollBody={false}` whose
 * `body={<X fill … />}` element relies on `fill`. The fix is either to give the
 * body its own height/overflow (`<Scroll className="h-full">`) or to drop
 * `scrollBody={false}` and use Column's managed scroll body (`scrollBody`
 * default, optionally `hideScrollbar`), which IS a flex parent.
 */
const FILL_BEARING_TAGS = new Set(["Scroll", "Clip", "Column"]);

/** True when `attrs` contains a truthy `<name>` prop (`name` or `name={true}`). */
function hasTruthyBoolProp(
  attrs: TSESTree.JSXOpeningElement["attributes"],
  name: string,
): boolean {
  for (const attr of attrs) {
    if (attr.type !== "JSXAttribute") continue;
    if (attr.name.type !== "JSXIdentifier" || attr.name.name !== name) continue;
    // Bare `fill` (no value) is `true`.
    if (attr.value == null) return true;
    // `fill={true}` — a literal `true` expression.
    if (
      attr.value.type === "JSXExpressionContainer" &&
      attr.value.expression.type === "Literal" &&
      attr.value.expression.value === true
    ) {
      return true;
    }
    // Any other value (`fill={false}`, `fill={cond}`) is not statically truthy —
    // do not flag.
    return false;
  }
  return false;
}

/** True when `attrs` contains an explicit `scrollBody={false}`. */
function hasScrollBodyFalse(
  attrs: TSESTree.JSXOpeningElement["attributes"],
): boolean {
  for (const attr of attrs) {
    if (attr.type !== "JSXAttribute") continue;
    if (
      attr.name.type !== "JSXIdentifier" ||
      attr.name.name !== "scrollBody"
    )
      continue;
    return (
      attr.value?.type === "JSXExpressionContainer" &&
      attr.value.expression.type === "Literal" &&
      attr.value.expression.value === false
    );
  }
  return false;
}

export default createRule({
  name: "no-inert-fill-body",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a `fill` element (Scroll/Clip/Column) as the `body` of a `<Column scrollBody={false}>` — the block body wrapper is not a flex parent, so `fill` is inert and overflow never engages.",
    },
    schema: [],
    messages: {
      inertFillBody:
        "`<{{tag}} fill>` as the `body` of `<Column scrollBody={false}>` is broken: `scrollBody={false}` wraps the body in a plain block div (not a flex parent), so `fill`'s `min-h-0 flex-1` is inert — the body grows to full content height and its overflow never engages. Either let the body own its own height/overflow (e.g. `<Scroll className=\"h-full\">`) or drop `scrollBody={false}` and use Column's managed scroll body (`scrollBody` default + `hideScrollbar`), which IS a flex parent.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXElement(node: TSESTree.JSXElement) {
        const opening = node.openingElement;
        if (
          opening.name.type !== "JSXIdentifier" ||
          opening.name.name !== "Column"
        )
          return;
        if (!hasScrollBodyFalse(opening.attributes)) return;

        // Find the `body={<X … />}` attribute whose element bears a truthy `fill`.
        for (const attr of opening.attributes) {
          if (attr.type !== "JSXAttribute") continue;
          if (attr.name.type !== "JSXIdentifier" || attr.name.name !== "body")
            continue;
          if (
            attr.value?.type !== "JSXExpressionContainer" ||
            attr.value.expression.type !== "JSXElement"
          )
            return;
          const bodyEl = attr.value.expression.openingElement;
          if (
            bodyEl.name.type !== "JSXIdentifier" ||
            !FILL_BEARING_TAGS.has(bodyEl.name.name)
          )
            return;
          if (!hasTruthyBoolProp(bodyEl.attributes, "fill")) return;
          context.report({
            node: attr,
            messageId: "inertFillBody",
            data: { tag: bodyEl.name.name },
          });
          return;
        }
      },
    };
  },
});
