import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  DepItemActions,
  InstallDepAction,
  RemoveDepAction,
} from "./components/dep-item-actions";
import { dependenciesPane } from "./panes";

export default {
  description:
    "Debug → Dependencies: a DataView over every declared optional dependency (state, size, identity, last used, the install's latest log line) with Install / Remove row actions, pushed live from deps.states.",
  contributions: [
    Pane.Register({ pane: dependenciesPane }),
    DebugApp.Sidebar({
      id: "dependencies",
      title: "Dependencies",
      icon: symbol("deployed-code"),
      opens: { pane: dependenciesPane, params: {} },
    }),
    DepItemActions({ id: "install", component: InstallDepAction }),
    DepItemActions({ id: "remove", component: RemoveDepAction }),
  ],
  slots: {
    itemActions: DepItemActions,
    dependencies: dependenciesPane,
  },
} satisfies PluginDefinition;
