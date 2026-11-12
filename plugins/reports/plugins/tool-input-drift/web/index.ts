import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { ToolInputDriftCollector } from "./components/tool-input-drift-collector";
import { ToolInputDriftKindView } from "./components/tool-input-drift-kind-view";

export default {
  description:
    "Tool-input-drift collector: drains tool-call's toolInputDriftSink into a deduped report whenever a transcript tool card's input schema rejects an input its tool took (the call succeeded) — the renderer's schema is wrong, and the card falls back to the generic one — plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: ToolInputDriftCollector, scope: "page" }),
    Reports.KindView({
      match: "tool-input-drift",
      component: ToolInputDriftKindView,
    }),
  ],
} satisfies PluginDefinition;
