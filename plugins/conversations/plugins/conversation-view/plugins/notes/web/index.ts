import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { NotesArea } from "./components/notes-area";
import { NotesToggleButton } from "./components/notes-toggle-button";

export default {
  description:
    "Free-form per-conversation notes, auto-saved to the server. Always visible when notes exist; toggle via the note button.",
  contributions: [
    Conversation.AbovePromptInput({
      id: "notes",
      requires: [],
      component: NotesArea,
    }),
    Conversation.PromptBar({
      id: "notes-toggle",
      requires: [],
      component: NotesToggleButton,
      section: "Notes",
      sectionOrder: -1,
    }),
  ],
} satisfies PluginDefinition;
