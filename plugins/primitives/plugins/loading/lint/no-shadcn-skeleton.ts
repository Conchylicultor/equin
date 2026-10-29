/**
 * The shadcn `components/ui/skeleton.tsx` was deleted — its shimmer atom lives
 * in the `loading` primitive (<Loading variant="block"> etc.). This rule keeps
 * the dead import path from being resurrected by a future shadcn re-generation
 * or copy-paste.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-shadcn-skeleton",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow imports of the deleted ui-kit components/ui/skeleton — use the loading primitive instead.",
    },
    schema: [],
    messages: {
      shadcnSkeleton:
        "'components/ui/skeleton' was deleted. Use <Loading variant=\"block\"> (or rows/cards) from " +
        "@plugins/primitives/plugins/loading/web.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        if (
          typeof node.source.value === "string" &&
          node.source.value.endsWith("/components/ui/skeleton")
        ) {
          context.report({ node, messageId: "shadcnSkeleton" });
        }
      },
    };
  },
});
