import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { DependenciesButton } from "./components/dependencies-button";

export default {
  description:
    "The task's links in the conversation header: ↑ open blockers · ↓ open dependents (shown only on header hover when none is open: a faint ↕ when all are resolved, a link icon when there are none), one popover listing and editing every link of both directions.",
  contributions: [
    conversationPane.Actions({
      id: "dependencies",
      component: DependenciesButton,
    }),
  ],
} satisfies PluginDefinition;
