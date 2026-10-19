import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { accountsPane, accountPane } from "@plugins/auth/web";
import { Settings } from "@plugins/apps/plugins/settings/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Account settings surface: registers the accounts and account panes and the Settings sidebar entry.",
  contributions: [
    Pane.Register({ pane: accountsPane }),
    Pane.Register({ pane: accountPane }),
    Settings.Sidebar({
      id: "accounts",
      title: "Accounts",
      icon: symbol("key"),
      opens: { pane: accountsPane, params: {} },
    }),
  ],
} satisfies PluginDefinition;
