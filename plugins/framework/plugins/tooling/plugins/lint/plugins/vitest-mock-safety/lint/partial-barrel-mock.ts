import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { isFunction, viMethodOf } from "./vi-call";

const createRule = lintRuleCreator(import.meta.url);

// A `vi.mock("@plugins/…/web", () => ({ useLive: … }))` REPLACES the barrel
// with exactly the names the factory returns. The barrel belongs to another
// plugin and grows on its own: the day the code under test imports one more
// name from it, the suite dies on `No "X" export is defined on the mock` —
// and since tests are not run on push, it stays dead until someone runs it
// (build-button and histogram both rotted this way). A partial mock — spread
// the real module, override what the test drives — cannot rot that way:
//
//   vi.mock("@plugins/x/web", async (importOriginal) => ({
//     ...(await importOriginal<object>()),
//     useLive: () => state.history,
//   }));
//
// Scoped to `@plugins/` barrels: a relative module is the suite's own plugin,
// whose author edits both sides together. A suite that must NOT load the real
// barrel (a module-eval side effect) disables the rule on the line and says why.
export default createRule({
  name: "partial-barrel-mock",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a vi.mock factory of a plugin barrel to spread importOriginal(), so the barrel's later exports reach the code under test.",
    },
    schema: [],
    messages: {
      replacing:
        "This `vi.mock` replaces the whole `{{specifier}}` barrel with the factory's names; the first " +
        "export the code under test adds kills the suite. Make it partial: " +
        "`async (importOriginal) => ({ ...(await importOriginal<object>()), …overrides })`. " +
        "If the real barrel must not load, disable this rule on the line and say why.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const method = viMethodOf(node);
        if (method !== "mock" && method !== "doMock") return;
        const [target, factory] = node.arguments;
        if (
          target?.type !== AST_NODE_TYPES.Literal ||
          typeof target.value !== "string" ||
          !target.value.startsWith("@plugins/") ||
          !isFunction(factory)
        )
          return;
        const original = factory.params[0];
        const used =
          original?.type === AST_NODE_TYPES.Identifier &&
          context.sourceCode
            .getDeclaredVariables(factory)
            .some((v) => v.name === original.name && v.references.length > 0);
        if (!used)
          context.report({
            node: factory,
            messageId: "replacing",
            data: { specifier: target.value },
          });
      },
    };
  },
});
