import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type * as ts from "typescript";
import { HOOK_NAME, isBranded, keyName, typeMembers } from "./hook-brand";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * A `use*`-named field of a function type must be declared `Hook<…>`.
 *
 * This closes the set `hook-binding-name` enforces over. That rule can only see
 * a hook the TYPE says is one; a hook field declared as a bare
 * `useFoo: () => T` is invisible to it, so `const foo = props.useFoo` would slip
 * through. Requiring the brand wherever a hook field is declared means every
 * downstream binding inherits it — and with it the `use*` naming requirement.
 *
 * Checked: interface / type-literal property signatures (component props
 * included) whose explicit annotation has a callable member without the brand
 * (`useText: string | Hook<…>` passes; `useText: string | (() => string)` does
 * not), and every `use*` METHOD signature — a method type cannot carry the
 * brand, so the fix is converting it to a `Hook<…>` property. Function
 * declarations (`function useX`) and object literals (`vi.mock` factories) are
 * out of scope: they are values, not declared shapes.
 */
export default createRule({
  name: "use-field-branded",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a use*-named function-typed field (property or method signature) to be declared Hook<…>, so every binding that later holds it is forced to keep a use* name.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      unbrandedField:
        '`{{name}}` is a hook field but its type is not branded — declare it as `Hook<…>` (import type { Hook } from "@plugins/framework/plugins/hook-value/core"), so any binding that later holds it must keep a use* name (hook-value/hook-binding-name).',
      methodSignature:
        '`{{name}}` is a hook declared as a method signature, which cannot carry the hook brand — declare it as a property: `{{name}}: Hook<(…) => …>` (import type { Hook } from "@plugins/framework/plugins/hook-value/core").',
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      TSPropertySignature(node: TSESTree.TSPropertySignature) {
        if (node.computed) return;
        const name = keyName(node.key);
        if (name === undefined || !HOOK_NAME.test(name)) return;
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (!annotation) return;
        const tsType = services.esTreeNodeToTSNodeMap.get(
          annotation,
        ) as ts.TypeNode;
        const type = checker.getTypeFromTypeNode(tsType);
        const unbranded = typeMembers(type).some(
          (m) => m.getCallSignatures().length > 0 && !isBranded(m),
        );
        if (unbranded) {
          context.report({
            node: node.key,
            messageId: "unbrandedField",
            data: { name },
          });
        }
      },
      TSMethodSignature(node: TSESTree.TSMethodSignature) {
        if (node.computed || node.kind !== "method") return;
        const name = keyName(node.key);
        if (name === undefined || !HOOK_NAME.test(name)) return;
        context.report({
          node: node.key,
          messageId: "methodSignature",
          data: { name },
        });
      },
    };
  },
});
