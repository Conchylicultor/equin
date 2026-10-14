import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { FileCheckpointRow } from "./components/file-checkpoint-row";

export default {
  description:
    "Renders Claude Code's rewind checkpoints (file-history-delta) in the JSONL viewer as one quiet line: the file a rewind would restore, or remove when the agent created it.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "file-checkpoint",
      component: FileCheckpointRow,
    }),
  ],
} satisfies PluginDefinition;
