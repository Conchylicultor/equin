import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The `DropdownMenu*` components in `@plugins/primitives/plugins/css/plugins/ui-kit/web` wrap Base UI's
 * `Menu.Item` (`@base-ui/react/menu`), whose activation handler is **`onClick`** —
 * Base UI has no `onSelect` prop. But `onSelect` is a valid DOM attribute on the
 * underlying `<div>` (the native text-selection event), so TypeScript happily
 * accepts `<DropdownMenuItem onSelect={…}>` and the handler simply never fires —
 * a silent no-op click. (Radix's menu uses `onSelect`; this is the exact Radix→Base
 * UI porting footgun.)
 *
 * The rule fires on `onSelect` set on any interactive Base UI menu item wrapper and
 * auto-fixes it to `onClick`. It matches by the capitalized component identifier,
 * so it never touches a lowercase host element's genuine `onSelect` (text-selection
 * on an `<input>`/`<textarea>`).
 */
const MENU_ITEM_TAGS = new Set([
  "DropdownMenuItem",
  "DropdownMenuCheckboxItem",
  "DropdownMenuRadioItem",
]);

export default createRule({
  name: "no-menu-item-on-select",
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "Disallow onSelect on Base UI DropdownMenu items — their activation handler is onClick; onSelect is a silent no-op.",
    },
    schema: [],
    messages: {
      onSelect:
        "`onSelect` on a {{tag}} never fires — Base UI's Menu.Item uses `onClick` (onSelect is a valid <div> DOM attribute, so this no-ops silently). Use `onClick` instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "onSelect") return;

        const tag = node.parent.name;
        if (tag.type !== "JSXIdentifier" || !MENU_ITEM_TAGS.has(tag.name)) return;

        const attrName = node.name;
        context.report({
          node,
          messageId: "onSelect",
          data: { tag: tag.name },
          fix: (fixer) => fixer.replaceText(attrName, "onClick"),
        });
      },
    };
  },
});
