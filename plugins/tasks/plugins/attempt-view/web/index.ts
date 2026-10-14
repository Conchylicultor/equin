import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { AttemptSwitchButton } from "./components/attempt-switch-button";
import { attemptPane } from "./panes";

export { attemptPane } from "./panes";

export default {
  description:
    "Main pane at /a/:id showing an attempt's conversations on the left and the selected conversation on the right. Adds a toolbar button to the conversation view to switch into it.",
  contributions: [
    Pane.Register({ pane: attemptPane }),
    Conversation.ActionBar({
      id: "attempt-switch",
      requires: [],
      component: AttemptSwitchButton,
    }),
  ],
  slots: { attempt: attemptPane },
} satisfies PluginDefinition;
