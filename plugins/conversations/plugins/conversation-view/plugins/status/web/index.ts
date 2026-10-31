import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { STUCK_TURN_WAITING_FOR } from "@plugins/conversations/core";
import { StatusBadge } from "./components/status-badge";
import { StuckTurnNotice } from "./components/stuck-turn-notice";

export default {
  description:
    "Displays the conversation status as a colored badge in the toolbar, and names a stuck agent (one holding a message it never started) at the transcript's foot.",
  contributions: [
    conversationPane.Actions({ id: "status", component: StatusBadge }),
    JsonlViewer.PendingPrompt({
      match: STUCK_TURN_WAITING_FOR,
      component: StuckTurnNotice,
    }),
  ],
} satisfies PluginDefinition;
