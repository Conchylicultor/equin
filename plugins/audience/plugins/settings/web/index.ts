import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Settings } from "@plugins/apps/plugins/settings/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { profilePane } from "./panes";

export default {
  description:
    "The Developer mode switch in Settings: a Profile sidebar entry opening a pane that switches the user's audience (user | developer).",
  contributions: [
    Pane.Register({ pane: profilePane }),
    Settings.Sidebar({
      id: "profile",
      title: "Profile",
      icon: symbol("person"),
      opens: { pane: profilePane, params: {} },
    }),
  ],
  slots: { "settings-profile": profilePane },
} satisfies PluginDefinition;
