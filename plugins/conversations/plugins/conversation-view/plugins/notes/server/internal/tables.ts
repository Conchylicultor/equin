import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { conversationNotesShape } from "../../core";

export const conversationNotes = defineExtension(
  _conversations,
  "notes",
  conversationNotesShape,
);
export const _conversationNotesTable = conversationNotes.table;
