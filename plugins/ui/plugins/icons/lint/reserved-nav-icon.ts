import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { isIconRefModule } from "../core";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

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
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (!isIconRefModule(context.filename, node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          const imported =
            spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
          if (imported !== "symbol") continue;
          const variable = context.sourceCode
            .getDeclaredVariables(spec)
            .find((v) => v.name === spec.local.name);
          for (const ref of variable?.references ?? []) {
            const call = ref.identifier.parent;
            if (call?.type !== "CallExpression") continue;
            const [arg] = call.arguments;
            if (arg?.type !== "Literal" || typeof arg.value !== "string")
              continue;
            const key = RESERVED[arg.value];
            if (key === undefined) continue;
            context.report({
              node: call,
              messageId: "reserved",
              data: { name: arg.value, key },
            });
          }
        }
      },
    };
  },
});
