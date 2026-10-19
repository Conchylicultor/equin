import { useSyncExternalStore } from "react";

/**
 * A conversation's note as the page holds it, shared by the editor and the
 * toolbar toggle (two slots, so two component trees):
 * - `open`: the user opened the note with the toggle (an empty one shows only
 *   then);
 * - `draft`: the editor's live text, ahead of the debounced save — undefined
 *   while no editor holds one.
 */
interface NoteUi {
  open: boolean;
  draft: string | undefined;
}

const CLOSED: NoteUi = { open: false, draft: undefined };

const state = new Map<string, NoteUi>();
const listeners = new Map<string, Set<() => void>>();

function get(conversationId: string): NoteUi {
  return state.get(conversationId) ?? CLOSED;
}

function update(conversationId: string, patch: Partial<NoteUi>): void {
  const prev = get(conversationId);
  const next = { ...prev, ...patch };
  if (next.open === prev.open && next.draft === prev.draft) return;
  state.set(conversationId, next);
  listeners.get(conversationId)?.forEach((l) => l());
}

export function setOpen(conversationId: string, open: boolean): void {
  update(conversationId, { open });
}

export function setDraft(
  conversationId: string,
  draft: string | undefined,
): void {
  update(conversationId, { draft });
}

export function useNoteUi(conversationId: string): NoteUi {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(conversationId);
      if (!set) {
        set = new Set();
        listeners.set(conversationId, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    () => get(conversationId),
    () => CLOSED,
  );
}
