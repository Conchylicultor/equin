import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { reportIdKind } from "../../core";
import { _reports } from "./tables";

/**
 * What a report is called where its id is named — its one-line message, led by
 * its kind — or `null` when no report has that id. The read a `report-…`
 * chip's server half hands a model.
 */
export async function getReportTitle(id: string): Promise<string | null> {
  const [row] = await db
    .select({ kind: _reports.kind, message: _reports.message })
    .from(_reports)
    .where(eq(_reports.id, reportIdKind.key(id)))
    .limit(1);
  return row ? `${row.kind}: ${row.message}` : null;
}
