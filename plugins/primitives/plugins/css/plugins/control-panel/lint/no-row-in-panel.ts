import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A row inside a control panel is a `ControlPanel.Row` — never the generic
 * `css/row` `Row`.
 *
 * A control panel is a menu surface: its rows draw the shared menu row (ui-kit
 * `MENU_ROW_PAINT` — height, gap, type, the lit highlight on hover and keyboard
 * focus), so every panel and every dropdown look and highlight alike. A generic
 * `Row` dropped in has its own height, gap and padding, so the panel shows two
 * kinds of row; that is how the filter panel's field list ended up taller than
 * its presets and lit differently from them.
 *
 * A JSX-structure rule like `no-adhoc-panel-body`: from a `<Row>`, walk the JSX
 * parents up to the enclosing component, and report when one is a control-panel
 * element (`ControlPanel`, `ControlPanel.*`, `ControlPanelPopover`). A row
 * rendered by a different component than the panel around it is out of reach —
 * that is the honest limit of a per-file rule.
 *
 * Escape hatch per-site, travelling with the code:
 *
 *   // eslint-disable-next-line control-panel/no-row-in-panel -- <reason>
 */

/** `ControlPanel`, `ControlPanelPopover`, `ControlPanel.Section`, … */
function isControlPanelElement(name: TSESTree.JSXTagNameExpression): boolean {
  if (name.type === "JSXIdentifier") return /^ControlPanel/.test(name.name);
  if (name.type === "JSXMemberExpression") {
    let object: TSESTree.JSXTagNameExpression = name.object;
    while (object.type === "JSXMemberExpression") object = object.object;
    return object.type === "JSXIdentifier" && object.name === "ControlPanel";
  }
  return false;
}

/** A function DECLARATION, or a function bound to a capitalized name. */
function isComponentBoundary(node: TSESTree.Node): boolean {
  if (node.type === "FunctionDeclaration") return true;
  if (
    node.type !== "FunctionExpression" &&
    node.type !== "ArrowFunctionExpression"
  ) {
    return false;
  }
  const parent = node.parent;
  return (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier" &&
    /^[A-Z]/.test(parent.id.name)
  );
}

export default createRule({
  name: "no-row-in-panel",
  meta: {
    type: "problem",
    docs: {
      description:
        "A row inside a control panel is a ControlPanel.Row (the shared menu row), not the generic css/row Row",
    },
    schema: [],
    messages: {
      rowInPanel:
        "`<Row>` inside `<{{panel}}>`: draw it as a `ControlPanel.Row` (icon + onSelect), so it sizes and highlights like every other menu row.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "Row") {
          return;
        }
        let current: TSESTree.Node | undefined = node.parent?.parent;
        while (current) {
          if (
            current.type === "JSXElement" &&
            isControlPanelElement(current.openingElement.name)
          ) {
            context.report({
              node,
              messageId: "rowInPanel",
              data: {
                panel: context.sourceCode.getText(current.openingElement.name),
              },
            });
            return;
          }
          if (isComponentBoundary(current)) return;
          current = current.parent;
        }
      },
    };
  },
});
