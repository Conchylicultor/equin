import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { defaultNow } from "@plugins/infra/plugins/entities/server";
import { turnSummaryShape } from "../../core";

export const turnSummaries = defineExtension(
  _conversations,
  "turn_summary",
  turnSummaryShape,
  {
    columns: {
      caveats: { default: "" },
      actions: { default: "" },
      generatedAt: { default: defaultNow() },
    },
  },
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _turnSummariesTable = turnSummaries.table;
