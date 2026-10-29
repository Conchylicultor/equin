import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Native radio guardrail.
 *
 * A `<input type="radio">` is grouped by its `name` attribute, and nothing else.
 * Two groups that share a `name` ARE one group to the browser: selecting an
 * option in the first clears the second's native checked state, and arrow-key
 * roving focus walks across both. Every hand-rolled group therefore has to mint
 * a `name` that is unique per *instance* — not per component, not per field type
 * — and the two field renderers that tried both wrote a module-level literal
 * (`"enum-field"`, `"dynamic-enum-field"`), silently merging every instance on
 * the page into one group.
 *
 * What made it survive review is that a controlled `checked` prop repaints the
 * correct dots regardless, so the damage is invisible on screen and shows up
 * only in keyboard navigation and assistive-tech grouping.
 *
 * The fix is to remove the choice: `RadioGroup`
 * (`@plugins/primitives/plugins/css/plugins/radio-group/web`) derives `name`
 * from `useId()` and does not accept one, so a collision is unrepresentable.
 * This rule keeps the mechanic there by flagging raw `<input type="radio">`
 * everywhere else.
 *
 * Scope is deliberately narrow — only an intrinsic `<input>` whose `type` is the
 * literal string `"radio"` (bare or in an expression container). A computed
 * `type={someVar}` is not flagged: it is vanishingly rare and would need type
 * info to resolve, and this rule is intentionally syntax-only so it runs
 * everywhere cheaply. Button-based groups carrying `role="radiogroup"` (e.g.
 * `SegmentedControl`) are untouched — they have no native `name` and no
 * collision.
 *
 * No auto-fix: swapping in the primitive changes the surrounding markup
 * (label wrapper, option list shape), which is not safe to mechanize.
 */
export default createRule({
  name: "no-adhoc-radio",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow raw <input type="radio"> — the native `name` that groups radios must be minted per mount, which the RadioGroup primitive does via useId().',
    },
    schema: [],
    messages: {
      adhocRadio:
        'Raw `<input type="radio">` is banned. Radios are grouped by their HTML ' +
        "`name`, so a hand-written one merges every instance on the page into a " +
        "single native group — arrow-key navigation walks across all of them and " +
        "picking one clears the others, even though a controlled `checked` prop " +
        "keeps the dots looking right. Use `RadioGroup` from " +
        "@plugins/primitives/plugins/css/plugins/radio-group/web, which mints its " +
        "own `name` per mount and never exposes it.",
    },
  },
  defaultOptions: [],
  create(context) {
    /** True when a JSX attribute's value is the string literal `"radio"`, bare or wrapped. */
    function isRadioTypeValue(value: TSESTree.JSXAttribute["value"]): boolean {
      if (!value) return false;
      if (value.type === "Literal") return value.value === "radio";
      if (value.type === "JSXExpressionContainer") {
        const expr = value.expression;
        return expr.type === "Literal" && expr.value === "radio";
      }
      return false;
    }

    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        // Intrinsic <input> only — a component named `Input` composes its own
        // control and is out of scope.
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "input") {
          return;
        }
        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute") continue;
          if (attr.name.type !== "JSXIdentifier" || attr.name.name !== "type") {
            continue;
          }
          if (isRadioTypeValue(attr.value)) {
            context.report({ node, messageId: "adhocRadio" });
          }
          return;
        }
      },
    };
  },
});
