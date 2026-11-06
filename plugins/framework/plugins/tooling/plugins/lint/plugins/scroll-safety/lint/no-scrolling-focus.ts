import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** The lib.dom interface `HTMLElement.focus` / `SVGElement.focus` come from. */
const DOM_FOCUS_OWNER = "HTMLOrSVGElement";

/**
 * A DOM `element.focus()` scrolls: the browser brings the focused element
 * into view, moving every scroller around it. That is a scroll write the
 * other two scroll-safety rules cannot see, and it moved the page under the
 * reader (a table grip's menu made the page jump by the table's height: the
 * caret host pulled focus back with a bare `.focus()`).
 *
 * Type-aware: it matches the DOM method by where it is DECLARED, so a
 * `.focus()` of anything else — a Lexical editor, a caret surface, a block's
 * focus handle — is not its business.
 */
export default createRule({
  name: "no-scrolling-focus",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a DOM `element.focus(...)` outside the scroll-reveal primitive — it scrolls implicitly. Use `focusElement(el, { reveal })`.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      scrollingFocus:
        "A DOM `.focus()` scrolls the element into view — an implicit scroll write that moves the page under the reader. Use `focusElement(el, { reveal })` from `@plugins/primitives/plugins/dom/plugins/scroll-reveal/web`: focus never scrolls there, and `reveal` states whether this focus follows the user's own navigation (`true`) or is moved for them (`false`).",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "focus"
        )
          return;
        const symbol = checker.getSymbolAtLocation(
          services.esTreeNodeToTSNodeMap.get(callee.property),
        );
        const owners = (symbol?.declarations ?? []).map((d) => {
          const parent = d.parent as { name?: { getText(): string } };
          return parent.name?.getText();
        });
        if (!owners.includes(DOM_FOCUS_OWNER)) return;
        context.report({ node, messageId: "scrollingFocus" });
      },
    };
  },
});
