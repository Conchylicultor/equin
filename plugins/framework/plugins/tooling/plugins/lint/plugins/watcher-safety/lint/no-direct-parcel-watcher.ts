import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-direct-parcel-watcher",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct @parcel/watcher value-imports outside the file-watcher plugin.",
    },
    schema: [],
    messages: {
      directImport:
        "Import `@parcel/watcher` only inside the file-watcher engine. Declare " +
        "the watcher with `defineFileWatcher` from " +
        "`@plugins/infra/plugins/file-watcher/server` (or `watchForCommand` " +
        "from its `cli` barrel in a foreground command), so the release's " +
        "vendored native addon override is honored " +
        "and the watcher is listed in Background activity. Type-only imports " +
        "are allowed.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        // Type-only imports never load the native addon — always allowed.
        if (node.importKind === "type") return;
        const source = node.source.value;
        if (
          source === "@parcel/watcher" ||
          source.startsWith("@parcel/watcher/")
        ) {
          context.report({ node, messageId: "directImport" });
        }
      },
    };
  },
});
