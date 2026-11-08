import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * A report's id (`reports.id`), declared once (`plugins/ids`): the mint in
 * `recordReport`, and the recognition a transcript's `report-…` chip and the
 * detail pane's route read. Rows minted as `report-<ms>-<≤6>` stay recognised,
 * and so do the `crash-<ms>-<6>` ids of rows minted before the reports
 * generalised from crashes (main still holds them; never minted again).
 */
export const reportIdKind = defineIdKind({
  prefix: "report",
  label: "Report",
  aliases: ["crash"],
});

export type ReportId = IdOf<typeof reportIdKind>;
