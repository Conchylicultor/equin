import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import { iconUsesIn } from "@plugins/ui/plugins/icons/plugins/icon-uses/core";

const createRule = lintRuleCreator(import.meta.url);

/** Each reserved glyph → the `navIcons` key that owns it (`core/nav-icons.ts`). */
const RESERVED: Record<string, string> = {
  "open-in-new": "newTab",
  "right-panel-open": "sidePane",
  "open-in-full": "expand",
  "tab-new-right": "newAppTab",
};

/**
 * The glyphs that say where a navigating control sends you are spelled only
 * through `navIcons` — so a control cannot pick the new-tab arrow for a pane it
 * opens beside you, nor the expand arrows for a new browser tab.
 */
export default createRule({
  name: "reserved-nav-icon",
  meta: {
    type: "problem",
    docs: {
      description:
        "Reserve the navigation glyphs (open-in-new, right-panel-open, open-in-full, tab-new-right) to navIcons from the icons core.",
    },
    schema: [],
    messages: {
      reserved:
        '`symbol("{{name}}")` is a navigation icon: use `navIcons.{{key}}` from the icons core, and pick the key by where the control sends you (newTab / newAppTab / sidePane / expand / hostApp).',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(program: TSESTree.Program) {
        const { calls } = iconUsesIn(
          program,
          context.filename,
          context.sourceCode.getDeclaredVariables.bind(context.sourceCode),
        );
        for (const { marker, name, call } of calls) {
          if (marker !== "symbol") continue;
          const key = RESERVED[name];
          if (key === undefined) continue;
          context.report({
            node: call as TSESTree.CallExpression,
            messageId: "reserved",
            data: { name, key },
          });
        }
      },
    };
  },
});
