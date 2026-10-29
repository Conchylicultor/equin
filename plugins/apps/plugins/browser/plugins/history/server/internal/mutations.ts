import { db } from "@plugins/database/server";
import { browserVisitIdKind } from "../../core";
import { visitTitleFor } from "../../shared/visit-title";
import { browserHistory } from "./tables";

export async function recordVisit(url: string): Promise<void> {
  await db.insert(browserHistory).values({
    id: browserVisitIdKind.mint(),
    url,
    title: visitTitleFor(url),
  });
}
