import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { scopedOutDispatchSink } from "@plugins/primitives/plugins/slot-render/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectScopedOutDispatch } from "./internal/scoped-out-dispatch-collector";
import { ScopedOutDispatchKindView } from "./components/scoped-out-dispatch-kind-view";

export default {
  description:
    "Scoped-out-dispatch collector: drains slot-render's scopedOutDispatchSink into a deduped report whenever a dispatch slot renders its fallback inside a PluginScope though the page holds a contribution for that key which the scope's composition neither bundles nor negates (the demo's tool cards falling back to the generic card), plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "primitives.slot-render",
      collect: drain(scopedOutDispatchSink, collectScopedOutDispatch),
      companion: true,
    }),
    Reports.KindView({
      match: "scoped-out-dispatch",
      component: ScopedOutDispatchKindView,
    }),
  ],
} satisfies PluginDefinition;
