import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * An overlay panel owns its inset — `padding="none"` hands it back to the
 * content.
 *
 * A popover or menu's `padding` role IS its rail region (`POPOVER_PADDING`
 * maps each role to one `rail-<step>`). `padding="none"` opens a region of
 * width zero, so every child must pick its own inset — and they do, each a
 * different one: the build popover's header at `px-md`, the tag picker's search
 * at `p-sm` and its tree at `p-2xs`, the notifications rows at `pl-md`. Text
 * edges stop lining up, and a panel moved to another host loses its padding.
 *
 * The replacement is always a step: the panel pays, the content declares no
 * inset, its edge strips are the panel's own `header` / `footer`, and a rule in
 * mid-content is a `Band`. A child that IS a self-contained surface (a color
 * picker card, a folder browser with its own chrome) is the one legitimate
 * `none` — it says so in a per-site disable.
 *
 * Name-based on the closed set of overlay hosts that take a `padding` role,
 * matching only the literal `"none"`, the house convention for JSX-shape rules.
 *
 *   // eslint-disable-next-line rail/no-unowned-overlay -- <reason>
 */
const OVERLAY_HOSTS = new Set([
  "PopoverContent",
  "InlinePopover",
  "OverlayPanel",
  "FloatingSurface",
]);
const MENU_CONTENT = /^DropdownMenu\w*Content$/;

function isOverlayHost(name: string): boolean {
  return OVERLAY_HOSTS.has(name) || MENU_CONTENT.test(name);
}

function isLiteralNone(value: TSESTree.JSXAttribute["value"]): boolean {
  if (value == null) return false;
  if (value.type === "Literal") return value.value === "none";
  if (
    value.type === "JSXExpressionContainer" &&
    value.expression.type === "Literal"
  ) {
    return value.expression.value === "none";
  }
  return false;
}

export default createRule({
  name: "no-unowned-overlay",
  meta: {
    type: "suggestion",
    docs: {
      description:
        'Disallow `padding="none"` on an overlay panel: the panel owns its inset, its content declares none.',
    },
    schema: [],
    messages: {
      unowned:
        "`padding=\"none\"` on `{{host}}` hands the panel's inset back to its content, so each child picks its own and the text edges stop lining up. Give the panel a step (`xs` for a menu-like list, the default `panel` otherwise), drop the children's own padding, put the top/bottom strips in the panel's `header` / `footer` props and a rule in mid-content in a `<Band>` (primitives/css/column). A child that is itself a complete surface keeps `none` behind a per-site disable saying so.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        if (node.name.type !== "JSXIdentifier") return;
        const host = node.name.name;
        if (!isOverlayHost(host)) return;
        for (const attr of node.attributes) {
          if (
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier" &&
            attr.name.name === "padding" &&
            isLiteralNone(attr.value)
          ) {
            context.report({
              node: attr,
              messageId: "unowned",
              data: { host },
            });
          }
        }
      },
    };
  },
});
