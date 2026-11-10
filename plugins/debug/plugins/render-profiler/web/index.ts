import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { ProfilerInstaller } from "./internal/global-api";
import { renderProfilerPane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { renderProfilerPane } from "./panes";

export default {
  description:
    "On-demand React fiber-commit profiler: when started, attributes each commit to its initiating component and the offending hook (incl. useSyncExternalStore), surfaced as the Debug → Render Profiler pane and the window.__reactRenderProfiler API.",
  contributions: [
    Pane.Register({ pane: renderProfilerPane }),
    DebugApp.Sidebar({
      id: "render-profiler",
      title: "Render Profiler",
      icon: symbol("insights"),
      opens: { pane: renderProfilerPane, params: {} },
    }),
    Core.Root({ component: ProfilerInstaller, scope: "page" }),
  ],
  slots: { "render-profiler": renderProfilerPane },
} satisfies PluginDefinition;
