import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { askCandidatesShape } from "../../core";

export const askCandidateRows = defineExtension(
  _conversations,
  "places_ask",
  askCandidatesShape,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _askCandidatesTable = askCandidateRows.table;
