import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { idChipServer } from "@plugins/active-data/plugins/id-chip/server";
import { _reports, getReportTitle } from "@plugins/reports/server";
import { reportIdKind } from "@plugins/reports/core";
import { REPORT_CHIP_SURFACES } from "../core";

export default {
  description:
    "The report id chip's server half (idChipServer): resolves a `report-<id>` to its kind and message for the id registry and for model-read text.",
  contributions: [
    ...idChipServer({
      kind: reportIdKind,
      tables: [_reports],
      surfaces: REPORT_CHIP_SURFACES,
      resolve: async (id) => {
        const title = await getReportTitle(id);
        return title === null ? { found: false } : { found: true, title };
      },
    }),
  ],
} satisfies ServerPluginDefinition;
