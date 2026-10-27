import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Shell } from "@plugins/shell/web";
import { opensPane } from "@plugins/primitives/plugins/app-shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { welcomePane } from "./panes";

export { welcomePane } from "./panes";

export default {
  description:
    "Landing pane (agent-manager index) shown at `/agents`, and the sidebar's New conversation entry, which opens it — its one prompt is where a conversation starts.",
  contributions: [
    Pane.Register({ pane: welcomePane }),
    Shell.Sidebar({
      id: "new-conversation",
      title: "New conversation",
      icon: symbol("add"),
      opens: opensPane(welcomePane, {}),
    }),
  ],
  slots: { welcome: welcomePane },
} satisfies PluginDefinition;
