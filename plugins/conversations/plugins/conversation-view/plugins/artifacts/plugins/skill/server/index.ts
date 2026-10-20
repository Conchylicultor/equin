import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConversationArtifactExtractor } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/server";
import { SKILL_KIND, extractSkills } from "../core";

export default {
  portable: true,
  description:
    "Server half of the skill artifact kind: its pure extractor, run over the whole transcript by the artifacts host.",
  contributions: [
    ConversationArtifactExtractor({
      id: SKILL_KIND,
      origin: "consumed",
      extract: extractSkills,
    }),
  ],
} satisfies ServerPluginDefinition;
