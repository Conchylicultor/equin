import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { SessionContextView } from "./components/session-context-view";

export default {
  collapsed: true,
  description:
    "Renders the session-context attachment — the ambient briefing blocks (user identity, git status, …) the harness injected at launch — as one collapsed card with a section per block.",
  contributions: [
    ...attachmentRenderer({
      match: "session_context",
      component: SessionContextView,
      role: "context",
    }),
  ],
} satisfies PluginDefinition;
