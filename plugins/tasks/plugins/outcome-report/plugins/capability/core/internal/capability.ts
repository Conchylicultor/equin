import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/** Must end its work with an outcome report (`submit_outcome_report`); its
 * conversation cannot stop before it has submitted one. */
export const reportRequired = defineCapability<true>({
  id: "report.required",
  schema: z.literal(true),
  label: "Report required",
});
