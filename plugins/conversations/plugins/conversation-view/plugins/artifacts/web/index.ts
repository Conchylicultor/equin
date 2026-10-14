import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { ConversationArtifacts } from "./slots";
import { ArtifactsButton } from "./components/artifacts-button";

export { ConversationArtifacts, type ArtifactKind } from "./slots";
export {
  useConversationArtifacts,
  type ConversationArtifactsResult,
} from "./use-conversation-artifacts";
export { useCloseArtifacts } from "./internal/close-context";
export { ArtifactSection } from "./components/artifact-section";
export { ArtifactRow, type ArtifactRowProps } from "./components/artifact-row";
export { RelationMarker } from "./components/relation-marker";

export default {
  description:
    "Conversation toolbar button listing everything the conversation made, changed or looked at. Owns the ConversationArtifacts.Kind registry each kind of artifact contributes to (a pure extractor over transcript events plus its own section), the aggregation over the already-open jsonl-events subscription, the popover, and the shared row / section / relation-mark chrome every kind renders through. Names no kind.",
  slots: ConversationArtifacts,
  contributions: [
    Conversation.ActionBar({
      id: "artifacts",
      requires: [],
      component: ArtifactsButton,
    }),
  ],
} satisfies PluginDefinition;
