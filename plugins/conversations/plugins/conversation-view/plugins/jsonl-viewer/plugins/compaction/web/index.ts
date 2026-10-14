import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { CompactionRow } from "./components/compaction-row";

export default {
  description:
    "Renders a context compaction as one thin rule across the transcript — Context compacted · 316k → 12k — folding the summary the agent continues from (as markdown) and the files it re-read.",
  contributions: [
    JsonlViewer.EventRenderer({
      match: "compaction",
      component: CompactionRow,
    }),
  ],
} satisfies PluginDefinition;
