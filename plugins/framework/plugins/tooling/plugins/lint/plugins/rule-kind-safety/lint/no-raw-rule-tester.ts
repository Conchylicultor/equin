import type { TSESTree } from "@typescript-eslint/utils";
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/** The packages a `RuleTester` class comes from. */
const SOURCES = new Set(["eslint", "@typescript-eslint/rule-tester"]);

/**
 * A lint-rule test builds its tester with `createRuleTester` /
 * `createTypedRuleTester` from `tooling/lint/core/testing`, never
 * `new RuleTester(…)`. `bun test` runs every test file in one process, and a
 * hand-made tester leans on process-wide state it cannot set safely: without
 * bun's describe/it it runs every case inline while its file loads (a pass
 * registers nothing, a failure is an error between tests), and a typed one
 * inherits whichever project service the first typed suite created.
 */
export default createRule({
  name: "no-raw-rule-tester",
  meta: {
    type: "problem",
    docs: {
      description:
        "Rule tests build their tester with createRuleTester / createTypedRuleTester from lint/core/testing, never new RuleTester.",
    },
    schema: [],
    messages: {
      raw: "Build the tester with `createRuleTester` (or `createTypedRuleTester` for a type-aware rule) from `@plugins/framework/plugins/tooling/plugins/lint/core/testing`, not `new RuleTester`: it registers the cases as bun tests and gives a typed suite its own project service — a hand-made one runs its cases at load time, or inherits the first typed suite's service in a full run.",
    },
  },
  defaultOptions: [],
  create(context) {
    /** Local names bound to a RuleTester class, or to a namespace holding one. */
    const classes = new Set<string>();
    const namespaces = new Set<string>();

    const isRuleTester = (node: TSESTree.Node | null): boolean =>
      (node?.type === "Identifier" && classes.has(node.name)) ||
      (node?.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        namespaces.has(node.object.name) &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "RuleTester");

    return {
      ImportDeclaration(node) {
        if (!SOURCES.has(node.source.value) || node.importKind === "type") {
          return;
        }
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.importKind !== "type" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "RuleTester"
          ) {
            classes.add(spec.local.name);
          } else if (spec.type !== "ImportSpecifier") {
            namespaces.add(spec.local.name);
          }
        }
      },
      NewExpression(node) {
        if (isRuleTester(node.callee))
          context.report({ node, messageId: "raw" });
      },
      "ClassDeclaration, ClassExpression"(
        node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
      ) {
        if (isRuleTester(node.superClass)) {
          context.report({ node, messageId: "raw" });
        }
      },
    };
  },
});
