import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConversationArtifactExtractor } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/server";
import { PAGE_KIND, extractPageHits } from "../core";

export default {
  portable: true,
  description:
    "Server half of the page artifact kind: its pure extractor, run over the whole transcript by the artifacts host.",
  contributions: [
    ConversationArtifactExtractor({
      id: PAGE_KIND,
      origin: "produced",
      extract: extractPageHits,
    }),
  ],
} satisfies ServerPluginDefinition;
