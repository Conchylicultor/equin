import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** Keys that name the parser services: a call's callee, a member, a binding. */
const SERVICES_CALL = "getParserServices";
const SERVICES_MEMBER = "parserServices";

function keyName(key: TSESTree.Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function property(
  obj: TSESTree.ObjectExpression,
  name: string,
): TSESTree.Property | undefined {
  return obj.properties.find(
    (p): p is TSESTree.Property =>
      p.type === "Property" && !p.computed && keyName(p.key) === name,
  );
}

/**
 * A lint rule's kind is declared on the rule — `meta.docs.requiresTypeChecking`
 * (lint/core's `isTypeAwareRule`) — and the type-check lint cache keys a
 * syntactic rule's result on the file's own text alone. A rule that reads
 * types without declaring it would cache an answer that goes stale when a
 * declaration it saw changes. The syntactic pass runs without a program, so a
 * `getParserServices` reached on every file throws; this rule covers the one
 * reached lazily (on some files only), statically: a file that reads the
 * parser services must declare `requiresTypeChecking: true` — the literal —
 * on the rule object it defines.
 */
export default createRule({
  name: "type-aware-rule-declared",
  meta: {
    type: "problem",
    docs: {
      description:
        "A lint rule that reads parser services (getParserServices / parserServices) must declare meta.docs.requiresTypeChecking: true, so the type-check lint cache keys it on types, not on the file's text alone.",
    },
    schema: [],
    messages: {
      undeclared:
        "This rule reads type information (`{{via}}`) but its `meta.docs` does not declare `requiresTypeChecking: true`. Declare it (with `ESLintUtils.RuleCreator<LintRuleDocs>` from lint/core): the type-check lint cache keys an undeclared rule's result on the file's own text alone, so its answer would go stale when a declaration it read changes.",
      noRuleObject:
        "This file reads type information (`{{via}}`) but defines no rule object (`meta: { docs: { … } }`) to declare `requiresTypeChecking: true` on. Read the parser services in the rule's own file, so its kind is declared beside it.",
    },
  },
  defaultOptions: [],
  create(context) {
    let read: { node: TSESTree.Node; via: string } | undefined;
    const ruleMetas: TSESTree.Node[] = [];
    const undeclared: TSESTree.Node[] = [];
    const noteRead = (node: TSESTree.Node, via: string): void => {
      read ??= { node, via };
    };

    return {
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && !callee.computed
              ? keyName(callee.property)
              : undefined;
        if (name === SERVICES_CALL) noteRead(node, SERVICES_CALL);
      },
      MemberExpression(node) {
        if (!node.computed && keyName(node.property) === SERVICES_MEMBER) {
          noteRead(node, SERVICES_MEMBER);
        }
      },
      // `const { parserServices } = context.sourceCode`
      "ObjectPattern > Property"(node: TSESTree.Property) {
        if (!node.computed && keyName(node.key) === SERVICES_MEMBER) {
          noteRead(node, SERVICES_MEMBER);
        }
      },
      // `meta: { docs: { … } }` — a rule object's declaration.
      "ObjectExpression > Property"(node: TSESTree.Property) {
        if (
          node.computed ||
          keyName(node.key) !== "meta" ||
          node.value.type !== "ObjectExpression"
        ) {
          return;
        }
        const docs = property(node.value, "docs");
        if (docs === undefined) {
          ruleMetas.push(node);
          undeclared.push(node);
          return;
        }
        ruleMetas.push(docs);
        const flag =
          docs.value.type === "ObjectExpression"
            ? property(docs.value, "requiresTypeChecking")
            : undefined;
        const declared =
          flag?.value.type === "Literal" && flag.value.value === true;
        if (!declared) undeclared.push(docs);
      },
      "Program:exit"() {
        if (read === undefined) return;
        const { via } = read;
        if (ruleMetas.length === 0) {
          context.report({
            node: read.node,
            messageId: "noRuleObject",
            data: { via },
          });
          return;
        }
        for (const node of undeclared) {
          context.report({ node, messageId: "undeclared", data: { via } });
        }
      },
    };
  },
});
