import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { NotesArea } from "./components/notes-area";
import { NotesToggleButton } from "./components/notes-toggle-button";
import { conversationNotesDemo } from "./internal/demo-resource";

export default {
  description:
    "Free-form per-conversation notes, auto-saved to the server. A written note always shows, with a dot on the note button; the button opens and hides an empty note.",
  contributions: [
    conversationNotesDemo,
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
