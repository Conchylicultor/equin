import { useCallback, useEffect } from "react";
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
import { useIsOpen, setIsOpen, toggleIsOpen } from "./notes-visibility-store";

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
  const isOpen = useIsOpen(conversationId);

  // A written note opens itself, and stays open once seen: clearing it mid-edit
  // must not yank the editor away — the user hides the emptied note with the
  // toggle.
  useEffect(() => {
    if (noteExists) setIsOpen(conversationId, true);
  }, [conversationId, noteExists]);

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

  // A written note cannot be hidden — only an empty one toggles.
  const toggleVisible = useCallback(() => {
    if (!noteExists) toggleIsOpen(conversationId);
  }, [conversationId, noteExists]);

  return {
    ...field,
    // A written note always shows; an empty one only while toggled open.
    isVisible: noteExists || isOpen,
    noteExists,
    read: note,
    toggleVisible,
  };
}
