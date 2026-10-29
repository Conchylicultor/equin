import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/** The `symbol()` marker the icons core exports. */
const ICONS_CORE = "@plugins/ui/plugins/icons/core";

// The robot-face glyphs look cheap and unprofessional, and agents keep reaching
// for them to represent agents/AI. Material Symbols draws a robot three ways.
const ROBOT_SYMBOLS = new Set(["smart-toy", "robot", "robot-2"]);

export default createRule({
  name: "no-robot-icon",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the robot-face symbols (symbol("smart-toy") and its variants) — use symbol("auto-awesome") to represent agents/AI.',
    },
    schema: [],
    messages: {
      robotIcon:
        'Robot icon symbol("{{name}}") is banned — it looks unprofessional. ' +
        'Use symbol("auto-awesome") to represent agents/AI (the codebase\'s canonical AI glyph).',
    },
  },
  defaultOptions: [],
  create(context) {
    let imported = false;
    return {
      ImportDeclaration(node) {
        if (node.source.value !== ICONS_CORE) return;
        imported ||= node.specifiers.some(
          (s) =>
            s.type === "ImportSpecifier" &&
            s.imported.type === "Identifier" &&
            s.imported.name === "symbol" &&
            s.local.name === "symbol",
        );
      },
      CallExpression(node) {
        if (!imported) return;
        if (node.callee.type !== "Identifier" || node.callee.name !== "symbol")
          return;
        const [arg] = node.arguments;
        if (
          arg?.type === "Literal" &&
          typeof arg.value === "string" &&
          ROBOT_SYMBOLS.has(arg.value)
        ) {
          context.report({
            node: arg,
            messageId: "robotIcon",
            data: { name: arg.value },
          });
        }
      },
    };
  },
});
