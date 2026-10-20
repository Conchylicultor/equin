import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConversationArtifactExtractor } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/server";
import { PROTOTYPE_KIND, extractPrototypeHits } from "../core";

export default {
  portable: true,
  description:
    "Server half of the prototype artifact kind: its pure extractor, run over the whole transcript by the artifacts host.",
  contributions: [
    ConversationArtifactExtractor({
      id: PROTOTYPE_KIND,
      origin: "produced",
      extract: extractPrototypeHits,
    }),
  ],
} satisfies ServerPluginDefinition;
