import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import { iconUsesIn, RESERVED_STATE_GLYPHS } from "../core";

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
      Program(program: TSESTree.Program) {
        const { calls } = iconUsesIn(
          program,
          context.filename,
          context.sourceCode.getDeclaredVariables.bind(context.sourceCode),
        );
        for (const { marker, name, call } of calls) {
          if (marker !== "symbol") continue;
          const key = RESERVED_STATE_GLYPHS[name];
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
