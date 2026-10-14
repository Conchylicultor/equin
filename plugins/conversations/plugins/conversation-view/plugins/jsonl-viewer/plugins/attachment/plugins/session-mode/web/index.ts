import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { attachmentRenderer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { SessionModeView } from "./components/session-mode-view";

export default {
  collapsed: true,
  description:
    "Renders the attachments that announce the rules the session runs under from here on — auto mode and its switches, entering and leaving plan mode, and ultracode.",
  contributions: [
    // Four spellings of one fact, so one component: the reading differs only in
    // label, icon and which value is worth naming.
    ...attachmentRenderer({
      match: "auto_mode",
      component: SessionModeView,
      role: "context",
    }),
    ...attachmentRenderer({
      match: "plan_mode",
      component: SessionModeView,
      role: "conversation",
    }),
    ...attachmentRenderer({
      match: "plan_mode_exit",
      component: SessionModeView,
      role: "conversation",
    }),
    ...attachmentRenderer({
      match: "ultra_effort_enter",
      component: SessionModeView,
      role: "conversation",
    }),
  ],
} satisfies PluginDefinition;
