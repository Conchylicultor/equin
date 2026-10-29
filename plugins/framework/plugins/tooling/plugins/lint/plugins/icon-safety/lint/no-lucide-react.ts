import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-lucide-react",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow lucide-react imports — icons are symbol() IconRefs drawn by <Icon>.",
    },
    schema: [],
    messages: {
      lucideImport:
        "Import from 'lucide-react' is banned. Name the glyph with symbol(\"…\") from @plugins/ui/plugins/icons/core " +
        'and draw it with <Icon icon={…}/> (e.g. symbol("close") for X, symbol("check") for Check, symbol("chevron-right") for ChevronRight). ' +
        "See plugins/ui/plugins/icons/CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value === "lucide-react") {
          context.report({ node, messageId: "lucideImport" });
        }
      },
    };
  },
});
