import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A rule-bearing strip is a member, not a class recipe.
 *
 * `border-b px-md py-sm` is a band — a hairline with an inset strip of content
 * — written by hand, and each hand picks its own inline inset: `px-lg`,
 * `px-md`, `px-sm` all appeared for the same role. Its text then sits on an
 * edge that matches nothing around it, and the hairline stops at the padding of
 * whatever region it lands in instead of spanning it.
 *
 * The replacement names the role:
 *
 *   - a panel's top / bottom strip is the panel's own `header` / `footer`
 *     (`OverlayPanel` / `PopoverContent` / `DropdownMenuContent`), and a
 *     column's is its `header` / `footer` with `rules`;
 *   - a rule in mid-content is `<Band rule="top|bottom|both">`
 *     (primitives/css/column), whose text lands on the host's text rail.
 *
 * Fires on ONE element's class expression (the shared walk, same-file aliases
 * followed) carrying both a top/bottom border (`border-t` / `border-b` /
 * `border-y`, any variant that styles the element itself) and an inline or
 * block padding class (`px-*` / `py-*`). A strip whose inline inset is the
 * RAIL's — `rail-band` (the band mechanics themselves: the panel strips,
 * `Band`), `rail-bleed` (the escape: cancel and re-apply) or `rail-follow`
 * (pay what the region owes) — picked no inset by hand, so it is not a recipe.
 * A border colour, width or style class (`border-transparent`,
 * `border-dashed`, `border-b-2`) is not an edge and does not count.
 *
 *   // eslint-disable-next-line rail/no-adhoc-band -- <reason>
 */
const RULE_EDGE = /^border-[tby]$/;
const STRIP_PAD = /^p[xy]-/;
const RAIL_INSET = new Set(["rail-band", "rail-bleed", "rail-follow"]);

export default function buildRule({
  collectTokens,
  ownClass,
  CLASS_ATTRS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-band",
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Disallow a hand-rolled rule strip (`border-b px-* py-*`): use the surface's header/footer or a <Band>.",
      },
      schema: [],
      messages: {
        adhocBand:
          "`{{edge}}` + `{{pad}}` on one element is a hand-rolled band: it picks its own inset, so its text misses the rows' edge and its hairline stops at the region's padding. A panel's or column's first/last strip is its own `header` / `footer` (`OverlayPanel`/`PopoverContent`/`DropdownMenuContent` props; `Column` with `rules`); a rule in mid-content is `<Band rule=\"top|bottom|both\">` from primitives/css/column, which bleeds the rule and puts its text on the host's text rail.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(attr: TSESTree.JSXAttribute) {
          if (
            attr.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(attr.name.name) ||
            attr.value == null
          ) {
            return;
          }
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, attr.value, tokens);
          for (const token of tokens) if (RAIL_INSET.has(token)) return;
          let edge: string | undefined;
          let pad: string | undefined;
          for (const token of tokens) {
            const own = ownClass(token);
            if (own === undefined) continue;
            if (edge === undefined && RULE_EDGE.test(own)) edge = own;
            if (pad === undefined && STRIP_PAD.test(own)) pad = own;
          }
          if (edge !== undefined && pad !== undefined) {
            context.report({
              node: attr,
              messageId: "adhocBand",
              data: { edge, pad },
            });
          }
        },
      };
    },
  });
}
