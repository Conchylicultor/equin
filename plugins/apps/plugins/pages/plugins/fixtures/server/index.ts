import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { writePageTree } from "./internal/write-page-tree";

export default {
  portable: true,
  description:
    "Pages fixtures, server half: writePageTree writes a PageTreeFixture through the real write path — the forest in one applyPageBlockPatch (so links, search and history derive from blocksChanged), then each page's tags and star. Derives nothing itself.",
} satisfies ServerPluginDefinition;
