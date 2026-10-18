import { useCallback } from "react";
import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import {
  useEditableField,
  type EditableField,
} from "@plugins/primitives/plugins/editable-field/web";
import { conversationNoteRows, type ConversationNote } from "../../shared";
import { upsertNote, deleteNote } from "./api";
import { useIsOpen, toggleIsOpen } from "./notes-visibility-store";

export interface ConversationNoteState extends EditableField<string> {
  isVisible: boolean;
  noteExists: boolean;
  /**
   * The note row's read — loading, failed, or ready. Render its `error` arm
   * as an error (never as "still loading").
   */
  read: LiveRowResult<ConversationNote>;
  toggleVisible: () => void;
}

export function useConversationNote(
  conversationId: string,
): ConversationNoteState {
  const note = useLiveRow(conversationNoteRows, conversationId);
  // Until the row is ready, serverNote stays "" so useEditableField (which must
  // run unconditionally) has a valid initial value. Consumers gate on `read`
  // to avoid showing a blank note before the row settles. On the ready arm
  // `found: false` means this conversation has no note.
  // Loading and error both seed "" — the editor needs a value either way, and
  // `read` tells the consumer which of the two it is.
  let serverNote = "";
  if (note.status === "ready" && note.found) serverNote = note.row.notes;
  const noteExists = note.status === "ready" && serverNote.trim().length > 0;
  const isManuallyOpen = useIsOpen(conversationId);

  const handleSave = useCallback(
    async (next: string) => {
      if (next.trim() === "") {
        await deleteNote(conversationId);
      } else {
        await upsertNote(conversationId, next);
      }
    },
    [conversationId],
  );

  const field = useEditableField<string>({
    value: serverNote,
    onSave: handleSave,
    debounceMs: 1000,
  });

  const toggleVisible = useCallback(
    () => toggleIsOpen(conversationId),
    [conversationId],
  );

  return {
    ...field,
    // The note shows only while toggled open, written or not: the toggle is
    // the one way in, and its dot says a note is waiting behind it.
    isVisible: isManuallyOpen,
    noteExists,
    read: note,
    toggleVisible,
  };
}
