import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { reportIdKind } from "@plugins/reports/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { REPORT_CHIP_SURFACES } from "../core";
import { useReportTarget, useReportReferent } from "./internal/presenter";

export default {
  description:
    "Renders a bare `report-<id>` in a transcript as the generic id chip (the report's kind and message) that opens the report's detail pane, and presents the report id kind to the id registry.",
  contributions: [
    ...idChip({
      presenter: {
        kind: reportIdKind,
        icon: symbol("bug-report"),
        useReferent: useReportReferent,
        useTarget: useReportTarget,
      },
      surfaces: REPORT_CHIP_SURFACES,
    }),
  ],
} satisfies PluginDefinition;
