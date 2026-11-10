import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { EmitInstaller } from "./internal/global-api";
import { liveStateEmitPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { liveStateEmitPane } from "./panes";

export default {
  description:
    "Synthetic no-op live-state push emitter: drives N pushes/sec for a chosen resource so churn-driven render/DOM bugs reproduce deterministically, surfaced as the Debug → Live-State Emit pane and the window.__liveStateEmit API.",
  contributions: [
    Pane.Register({ pane: liveStateEmitPane }),
    DebugApp.Sidebar({
      id: "live-state-emit",
      title: "Live-State Emit",
      icon: symbol("bolt"),
      opens: { pane: liveStateEmitPane, params: {} },
    }),
    Core.Root({ component: EmitInstaller, scope: "page" }),
  ],
  slots: { "debug-live-state-emit": liveStateEmitPane },
} satisfies PluginDefinition;
