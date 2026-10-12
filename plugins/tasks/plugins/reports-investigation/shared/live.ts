import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { ReportKindScopeSchema } from "./scope";

/**
 * Every registered report kind with its severity and how many uninvestigated
 * reports of it have occurred at least `minCount` times — what the Which
 * reports section lists and counts. A typed query (`minCount` is a number);
 * served `db` in `server/internal/scope.ts`, so a recorded or investigated
 * report recomputes it.
 */
export const reportInvestigationsScope = liveValue(
  "report-investigations.scope",
  {
    schema: z.object({ kinds: z.array(ReportKindScopeSchema) }),
    query: z.object({ minCount: z.number().int().min(1) }),
  },
);
