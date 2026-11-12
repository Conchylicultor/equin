import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { tabMemoryClimbConfig } from "../core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { TabMemoryRecorder } from "./components/tab-memory-recorder";
import { tabMemoryPane } from "./panes";

export { tabMemoryPane } from "./panes";

export default {
  description:
    "Tab memory telemetry, browser half: every top-level page the user drives samples itself (JS heap, DOM nodes, canvases, images, its open in-app tabs and route) 30 s after load and every 5 minutes after, posted to its own server; Debug → Tab memory draws each page beside each Chrome renderer's footprint (by pid) over the last 12 h, with a DataView of the pages; registers the climb watch's bars (tab-memory-climb) for Settings → Config.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: tabMemoryClimbConfig }),
    Core.Root({ component: TabMemoryRecorder, scope: "page" }),
    Pane.Register({ pane: tabMemoryPane }),
    DebugApp.Sidebar({
      id: "tab-memory",
      title: "Tab memory",
      icon: symbol("memory"),
      opens: { pane: tabMemoryPane, params: {} },
    }),
  ],
  slots: { "debug-tab-memory": tabMemoryPane },
} satisfies PluginDefinition;
