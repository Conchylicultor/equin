import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationNoteRowsServed } from "./internal/resource";
import { handleUpsertNote, handleDeleteNote } from "./internal/routes";
import { upsertNote, deleteNote } from "../shared/endpoints";

export { conversationNotes } from "./internal/tables";

export default {
  description: "Per-conversation free-form notes, auto-saved to the server.",
  contributions: [...conversationNoteRowsServed.declare],
  httpRoutes: {
    [upsertNote.route]: handleUpsertNote,
    [deleteNote.route]: handleDeleteNote,
  },
} satisfies ServerPluginDefinition;
