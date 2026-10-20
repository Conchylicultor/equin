import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { conversationProgressShape } from "../../core";

export const conversationProgress = defineExtension(
  _conversations,
  "progress",
  conversationProgressShape,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _conversationProgressTable = conversationProgress.table;
