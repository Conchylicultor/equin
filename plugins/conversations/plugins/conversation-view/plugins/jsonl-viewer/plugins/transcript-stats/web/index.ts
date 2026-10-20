import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { TranscriptStats as TranscriptStatsSlots } from "./slots";
import { TranscriptStatsStrip } from "./components/transcript-stats-strip";

export { TranscriptStats } from "./slots";
export type { TranscriptStatContribution } from "./slots";
export { useTranscriptRead } from "./read-context";
export type { TranscriptRead } from "./read-context";
export { useTranscriptFold } from "./use-transcript-fold";
export { StatBadge } from "./components/stat-badge";
export type { StatTone } from "./components/stat-badge";

export default {
  description:
    "The transcript's status strip: the readings pinned at the foot of the conversation, and the TranscriptStats.Item slot they come from. Owns the reading position — the strip reports the transcript as far as the reader has scrolled, so scrolling back through history walks the numbers back with it.",
  contributions: [
    JsonlViewer.Overlay({
      id: "transcript-stats",
      component: TranscriptStatsStrip,
    }),
  ],
  slots: TranscriptStatsSlots,
} satisfies PluginDefinition;
