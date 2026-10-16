import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { conversationNoteRows } from "../../shared/schemas";

/** Inside a demo scope: No conversation carries a note. */
export const conversationNotesDemo = demoResource("conversation-notes", (s) => [
  s.serveCollection(conversationNoteRows, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    rows: () => [],
  }),
]);
