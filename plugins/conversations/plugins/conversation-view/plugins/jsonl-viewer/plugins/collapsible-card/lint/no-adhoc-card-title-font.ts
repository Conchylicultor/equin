import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Transcript-card title-font guardrail.
 *
 * `CollapsibleCard` owns the title TYPOGRAPHY: its `HEADER` pins the one house
 * font + size for every transcript-card title, and the card renders the title
 * group (icon + `label` + muted `note`) itself, so any text inside inherits
 * that baseline by CSS inheritance (see `collapsible-card.tsx`). A title node
 * must therefore NOT set its own font-family: an explicit `font-mono`/`font-sans`
 * on a `label`/`note` child wins over the inherited family and reintroduces the
 * per-renderer drift (some titles mono, some sans) the container baseline exists
 * to close.
 *
 * Raw `text-*`/`leading-*` sizes are already banned everywhere by
 * `text/no-adhoc-typography`; font-family is NOT (it is legitimately used for
 * code bodies). This rule closes the remaining title-specific gap: a font-family
 * class applied INSIDE a card title.
 *
 * SCOPE — deliberately conservative; ZERO false positives is the priority.
 * Mirrors `pane/no-adhoc-pane-title`. Fires ONLY when ALL hold:
 *
 *   1. The attribute name is `label` or `note`.
 *   2. The element owning the attribute is `CollapsibleCard` (matched by
 *      opening-element identifier name; an aliased import is an accepted false
 *      negative).
 *   3. The attribute value is a `JSXExpressionContainer` wrapping inline JSX
 *      (`label={<…>}`). An identifier (`label={label}`) is skipped — we never
 *      trace a variable, an accepted false negative.
 *   4. A `className`/`class` attribute ON AN INTRINSIC HOST ELEMENT (`<span>`,
 *      `<div>`, …) in that subtree carries a string literal naming a font family
 *      (`font-mono`/`font-sans`/`font-serif`). A class on a COMPONENT element
 *      (`<Badge>`, `<Text>`, …) is NOT flagged: those are typography-owning
 *      primitives that legitimately set their own family — e.g. the sanctioned
 *      mono tool-name `<Badge>` identity chip. The drift this rule closes is the
 *      raw `<span className="font-mono">` title text, not a primitive's own type.
 *
 * Each offending `className` attribute is reported on its own node. Report-only,
 * no autofix: dropping the class (inherit the baseline) vs. keeping a deliberate,
 * eslint-disabled override is a human call.
 */

const FONT_FAMILY_RE = /\bfont-(mono|sans|serif)\b/;

/** Read a JSXAttribute's value as a static string, if it is one. */
function staticClassString(attr: TSESTree.JSXAttribute): string | null {
  const v = attr.value;
  if (!v) return null;
  if (v.type === "Literal" && typeof v.value === "string") return v.value;
  // className={"font-mono …"} — single string literal in a container.
  if (
    v.type === "JSXExpressionContainer" &&
    v.expression.type === "Literal" &&
    typeof v.expression.value === "string"
  ) {
    return v.expression.value;
  }
  return null;
}

/** A JSXOpeningElement is an intrinsic host element when its tag is a plain
 *  lowercase identifier (`span`, `div`). Components (`Badge`, `Text`) and
 *  member/namespace tags own their own typography and are exempt. */
function isIntrinsicHost(el: TSESTree.JSXOpeningElement): boolean {
  return (
    el.name.type === "JSXIdentifier" && /^[a-z]/.test(el.name.name)
  );
}

/** Recursively collect font-family className attributes on intrinsic host
 *  elements under `node`. */
function collectFontClasses(
  node: TSESTree.Node | null | undefined,
  out: TSESTree.JSXAttribute[],
): void {
  if (!node) return;
  if (
    node.type === "JSXAttribute" &&
    node.name.type === "JSXIdentifier" &&
    (node.name.name === "className" || node.name.name === "class") &&
    node.parent.type === "JSXOpeningElement" &&
    isIntrinsicHost(node.parent)
  ) {
    const str = staticClassString(node);
    if (str && FONT_FAMILY_RE.test(str)) out.push(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          collectFontClasses(child as TSESTree.Node, out);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      collectFontClasses(value as TSESTree.Node, out);
    }
  }
}

export default createRule({
  name: "no-adhoc-card-title-font",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a font-family class inside a CollapsibleCard label=/note= node — the card owns the transcript-card title font; a title node must inherit it, not pick its own family.",
    },
    schema: [],
    messages: {
      adhocCardTitleFont:
        "`{{cls}}` inside a CollapsibleCard `{{slot}}=` node overrides the title font " +
        "the card pins for every transcript card. Remove it and let the title inherit " +
        "the house font; keep a deliberate family only via " +
        "`// eslint-disable-next-line collapsible-card/no-adhoc-card-title-font -- reason`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node) {
        // 1. Slot gate: `label=` / `note=`.
        if (node.name.type !== "JSXIdentifier") return;
        const slot = node.name.name;
        if (slot !== "label" && slot !== "note") return;

        // 2. Owner allow-list: the element must be `CollapsibleCard`.
        const ownerTag = node.parent.name;
        if (ownerTag.type !== "JSXIdentifier" || ownerTag.name !== "CollapsibleCard") {
          return;
        }

        // 3. Only inline JSX: `label={<…>}`. Skip identifiers/calls — no tracing.
        if (node.value?.type !== "JSXExpressionContainer") return;
        const expr = node.value.expression;
        if (expr.type !== "JSXElement" && expr.type !== "JSXFragment") return;

        // 4. Flag every font-family className in the inline title subtree.
        const offenders: TSESTree.JSXAttribute[] = [];
        collectFontClasses(expr, offenders);
        for (const attr of offenders) {
          const cls = staticClassString(attr)?.match(FONT_FAMILY_RE)?.[0] ?? "font-*";
          context.report({
            node: attr,
            messageId: "adhocCardTitleFont",
            data: { cls, slot },
          });
        }
      },
    };
  },
});
