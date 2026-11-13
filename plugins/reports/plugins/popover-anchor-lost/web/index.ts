import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { popoverAnchorLostSink } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { drain } from "@plugins/primitives/plugins/report-sink/web";
import { ReportSinks } from "@plugins/reports/plugins/collectors/web";
import { collectPopoverAnchorLost } from "./internal/popover-anchor-lost-collector";
import { PopoverAnchorLostKindView } from "./components/popover-anchor-lost-kind-view";

export default {
  description:
    "Popover-anchor-lost collector: drains ui-kit's popoverAnchorLostSink into a deduped report whenever an open popover's anchor (its trigger, or the caller's anchor) leaves the document or is hidden under display: none — the moment the panel would have jumped to the screen's top-left corner — naming the popover, the anchor and the element that hid it (lineage, source line, owner), plus the Debug → Reports summary view.",
  contributions: [
    ReportSinks.Collector({
      from: "primitives.css.ui-kit",
      collect: drain(popoverAnchorLostSink, collectPopoverAnchorLost),
      companion: true,
    }),
    Reports.KindView({
      match: "popover-anchor-lost",
      component: PopoverAnchorLostKindView,
    }),
  ],
} satisfies PluginDefinition;
