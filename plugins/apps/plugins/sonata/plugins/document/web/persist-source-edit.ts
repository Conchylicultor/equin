import { useEffect, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useSourceEdit, type SourceEdit } from "./loaded-song";

/** A source's edit to save: its raw WITH the song and load it belongs to. */
export type EditedSource = Extract<SourceEdit, { kind: "edited" }>;

/** How long a source's edits settle before they are saved. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Persist the loaded library song's edits of source `sourceId`: `save` is
 * called with each edit once the user stops editing for a moment (debounced),
 * and the one way an edit leaves without being saved is a newer edit of the same
 * song and load (which carries it). Anything else that ends it saves it at
 * once, under its own song:
 *
 *  - another song (or another load of this one) is loaded, or the document
 *    stops being an edited library song;
 *  - the caller unmounts (the Sonata app scope goes away).
 *
 * So switching songs or leaving within the debounce cannot drop the last
 * edit: the save is flushed instead of cancelled. `save` may skip an edit that
 * is not user content (Ultimate Guitar's alignment-only change); it is read
 * fresh at call time.
 */
export function usePersistSourceEdit(
  sourceId: string,
  save: (edit: EditedSource) => void,
): void {
  const edit = useSourceEdit(sourceId);
  const saveRef = useLatestRef(save);
  const pending = useRef<{
    edit: EditedSource;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  useEffect(() => {
    const held = pending.current;
    if (held !== null) {
      clearTimeout(held.timer);
      pending.current = null;
      const supersedes =
        edit.kind === "edited" &&
        edit.songId === held.edit.songId &&
        edit.load === held.edit.load;
      if (!supersedes) saveRef.current(held.edit);
    }
    if (edit.kind !== "edited") return;
    const timer = setTimeout(() => {
      pending.current = null;
      saveRef.current(edit);
    }, SAVE_DEBOUNCE_MS);
    pending.current = { edit, timer };
  }, [edit, saveRef]);

  // Unmount: the held edit is saved now, not dropped with its timer.
  useEffect(
    () => () => {
      const held = pending.current;
      if (held === null) return;
      clearTimeout(held.timer);
      pending.current = null;
      saveRef.current(held.edit);
    },
    [saveRef],
  );
}
