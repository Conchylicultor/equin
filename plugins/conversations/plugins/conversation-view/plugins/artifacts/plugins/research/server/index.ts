import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConversationArtifactExtractor } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/server";
import { RESEARCH_KIND, extractResearch } from "../core";

export default {
  portable: true,
  description:
    "Server half of the research artifact kind: its pure extractor, run over the whole transcript by the artifacts host.",
  contributions: [
    ConversationArtifactExtractor({
      id: RESEARCH_KIND,
      origin: "produced",
      extract: extractResearch,
    }),
  ],
} satisfies ServerPluginDefinition;
