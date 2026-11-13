import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { toolInputDriftSink } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectToolInputDrift } from "./internal/tool-input-drift-collector";
import { ToolInputDriftKindView } from "./components/tool-input-drift-kind-view";

export default {
  description:
    "Tool-input-drift collector: drains tool-call's toolInputDriftSink into a deduped report whenever a transcript tool card's input schema rejects an input its tool took (the call succeeded) — the renderer's schema is wrong, and the card falls back to the generic one — plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "conversations.conversation-view.jsonl-viewer.tool-call",
      collect: drain(toolInputDriftSink, collectToolInputDrift),
      companion: true,
    }),
    Reports.KindView({
      match: "tool-input-drift",
      component: ToolInputDriftKindView,
    }),
  ],
} satisfies PluginDefinition;
