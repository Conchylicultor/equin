import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The base-ui `Menu.GroupLabel` component (our `DropdownMenuLabel`) reads its
 * ancestor `Menu.Group` context via `useMenuGroupRootContext`. Rendering it with
 * NO enclosing `Menu.Group` throws a hard runtime error (#31) that white-screens
 * the whole menu — a coupling that is invisible at author time.
 *
 * This rule flags any `<DropdownMenuLabel>` that has no enclosing
 * `<DropdownMenuGroup>` OR `<DropdownMenuSection>` element in the same component.
 * Crossing a function boundary while walking up counts as "no group" — a label
 * rendered in a different component from any group is exactly the dangerous case.
 */
const GROUP_ANCESTORS = new Set(["DropdownMenuGroup", "DropdownMenuSection"]);

const FUNCTION_BOUNDARIES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

export default createRule({
  name: "no-groupless-dropdown-menu-label",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a DropdownMenuLabel with no DropdownMenuGroup/DropdownMenuSection ancestor — base-ui's Menu.GroupLabel hard-crashes (#31) without a Menu.Group context.",
    },
    schema: [],
    messages: {
      grouplessLabel:
        "`DropdownMenuLabel` must be nested inside a `DropdownMenuGroup` — base-ui's `Menu.GroupLabel` throws a hard runtime error (#31 useMenuGroupRootContext) when rendered without a `Menu.Group` context, white-screening the menu. Use the `DropdownMenuSection` primitive (label + group + items in one unit) from @plugins/primitives/plugins/css/plugins/ui-kit/web, or wrap the label and its items in a `DropdownMenuGroup`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        if (
          node.name.type !== "JSXIdentifier" ||
          node.name.name !== "DropdownMenuLabel"
        )
          return;

        // Walk up the AST parent chain looking for an enclosing
        // DropdownMenuGroup/DropdownMenuSection JSXElement. Crossing a function
        // boundary (or reaching the top) without finding one = report.
        let current: TSESTree.Node | undefined = node.parent;
        while (current) {
          if (current.type === "JSXElement") {
            const opening = current.openingElement.name;
            if (
              opening.type === "JSXIdentifier" &&
              GROUP_ANCESTORS.has(opening.name)
            ) {
              return; // legal — inside a group/section
            }
          }
          if (FUNCTION_BOUNDARIES.has(current.type)) break;
          current = current.parent;
        }

        context.report({ node, messageId: "grouplessLabel" });
      },
    };
  },
});
