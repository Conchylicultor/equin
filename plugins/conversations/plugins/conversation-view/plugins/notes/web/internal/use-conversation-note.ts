import { useCallback } from "react";
import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import { conversationNoteRows, type ConversationNote } from "../../shared";
import { setOpen, useNoteUi } from "./notes-ui-store";

export interface ConversationNoteState {
  /**
   * The note row's read — loading, failed, or ready. Render its `error` arm
   * as an error (never as "still loading").
   */
  read: LiveRowResult<ConversationNote>;
  /**
   * The saved note. Until the row is ready it is "" — consumers gate on `read`
   * to avoid showing a blank note before the row settles.
   */
  serverNote: string;
  /** The note has text — the editor's live draft when one is held, else the saved note. */
  hasText: boolean;
  /** A note with text always shows; an empty one only while opened. */
  isVisible: boolean;
  /** Opens or hides an empty note; a note with text cannot be hidden. */
  toggleVisible: () => void;
}

export function useConversationNote(
  conversationId: string,
): ConversationNoteState {
  const read = useLiveRow(conversationNoteRows, conversationId);
  // On the ready arm `found: false` means this conversation has no note.
  let serverNote = "";
  if (read.status === "ready" && read.found) serverNote = read.row.notes;
  const { open, draft } = useNoteUi(conversationId);
  const hasText =
    read.status === "ready" && (draft ?? serverNote).trim().length > 0;

  const toggleVisible = useCallback(() => {
    if (!hasText) setOpen(conversationId, !open);
  }, [conversationId, hasText, open]);

  return {
    read,
    serverNote,
    hasText,
    isVisible: hasText || open,
    toggleVisible,
  };
}
