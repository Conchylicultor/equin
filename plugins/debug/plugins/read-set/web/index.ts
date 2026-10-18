import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { readSetPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { readSetPane } from "./panes";

export default {
  description:
    "Read-set debug pane: the captured loader→table index and the read-set ceiling — every live-state resource under its change policy (routed, external, unrouted, unbound), with its full routes, relation reads and route drift.",
  contributions: [
    Pane.Register({ pane: readSetPane }),
    DebugApp.Sidebar({
      id: "read-set",
      title: "Read-set",
      icon: symbol("table-chart"),
      opens: { pane: readSetPane, params: {} },
    }),
  ],
  slots: { "debug-read-set": readSetPane },
} satisfies PluginDefinition;
