import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import { isIconRefModule, RESERVED_STATE_GLYPHS } from "../core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The glyphs only a state can mean (in flight, waiting on you, partly done) are
 * spelled only through `stateIcons` — so every status list that has a "running"
 * draws the same glyph (spinning), and changing it is one edit in
 * `core/state-icons.ts`.
 */
export default createRule({
  name: "reserved-state-icon",
  meta: {
    type: "problem",
    docs: {
      description:
        "Reserve the state glyphs (progress-activity, front-hand, incomplete-circle) to stateIcons from the icons core.",
    },
    schema: [],
    messages: {
      reserved:
        '`symbol("{{name}}")` is a state icon: use `stateIcons.{{key}}` from the icons core, and map every value of your status list onto a stateIcons key (working / needsYou / done / failed / partial / canceled / paused / notStarted).',
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
            const key = RESERVED_STATE_GLYPHS[arg.value];
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
