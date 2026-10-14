import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { RemoteSessionView } from "./components/remote-session-view";

export default {
  collapsed: true,
  description:
    "Renders the remote_session_change attachment — the conversation became followed from claude.ai — as a one-line row linking out to the session.",
  contributions: [
    ...attachmentRenderer({
      match: "remote_session_change",
      component: RemoteSessionView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
