import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { artifactsServed } from "./internal/served";

export { ConversationArtifactExtractor } from "./internal/extractors";

export default {
  portable: true,
  description:
    "Serves what a conversation made, changed or looked at over its whole transcript (conversations.conversation-view.artifacts): owns the ConversationArtifactExtractor contribution each kind of artifact adds its pure extractor to, and runs every one over the transcript on the server. Names no kind.",
  contributions: [...artifactsServed.declare],
} satisfies ServerPluginDefinition;
