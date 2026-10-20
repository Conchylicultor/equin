import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConversationArtifactExtractor } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/server";
import { SCREENSHOT_KIND, extractScreenshots } from "../core";

export default {
  portable: true,
  description:
    "Server half of the screenshot artifact kind: its pure extractor, run over the whole transcript by the artifacts host.",
  contributions: [
    ConversationArtifactExtractor({
      id: SCREENSHOT_KIND,
      origin: "consumed",
      extract: extractScreenshots,
    }),
  ],
} satisfies ServerPluginDefinition;
