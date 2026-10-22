import { useCallback } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useUndoRedo } from "@plugins/primitives/plugins/undo-redo/web";
import { restoreTrash } from "../../core";
import type { TrashOutcome } from "../../core";

export interface UndoableTrashArgs {
  /** Human label for the history entry ("Delete Roadmap"). */
  label: string;
  /**
   * The caller's trashing mutation. Called once now, and AGAIN on every redo —
   * so it must be idempotent-in-intent (re-trash the same entity), not a
   * one-shot closure over a stale handle.
   */
  trash: () => Promise<TrashOutcome>;
  /** Ran after a successful restore (e.g. re-open the page that was closed). */
  onUndo?: () => void;
}

export type UndoableTrash = (args: UndoableTrashArgs) => Promise<TrashOutcome>;

/**
 * The generic "trashed → undoable" seam: run a trashing mutation and put it on
 * the tab's undo stack. Every trash source shares the same shape — the mutation
 * returns a {@link TrashOutcome} handle, undo is
 * `POST /api/trash/:sourceId/:entryId/restore`, and redo re-runs the mutation —
 * so the plugin that owns the concept owns the seam, and no consumer hand-rolls
 * restore.
 *
 * ```ts
 * const trashWithUndo = useUndoableTrash();
 * await trashWithUndo({
 *   label: `Delete ${title}`,
 *   trash: () => fetchEndpoint(deletePage, { id: pageId }),
 *   onUndo: () => openPane(pageDetailPane, { pageId }),
 * });
 * ```
 *
 * Notes on the two load-bearing details:
 *
 * - **Plain `useUndoRedo()`, never the scoped variant.** The recorded thunks are
 *   pure server calls keyed by a ledger id — valid anywhere in the tab — so the
 *   entry rightly outlives the pane/mount that recorded it (delete a page,
 *   navigate away, Cmd+Z still restores it).
 * - **Redo REASSIGNS the entry id.** A redo re-trashes, which mints a *new*
 *   ledger row; keeping the original id would make the next undo restore an
 *   already-consumed entry and take the primitive's typed 404.
 *
 * A `trashed: false` outcome records nothing — the domain hard-deleted, and
 * there is genuinely nothing to restore. It is returned to the caller honestly
 * rather than papered over.
 *
 * This plugin deliberately raises no toast and performs no navigation (that
 * would invert `infra → shell`): the consumer owns both.
 */
export function useUndoableTrash(): UndoableTrash {
  const { record } = useUndoRedo();
  const fetchEndpoint = useFetchEndpoint();

  return useCallback(
    async ({ label, trash, onUndo }: UndoableTrashArgs) => {
      const outcome = await trash();
      if (!outcome.trashed) return outcome;

      const { sourceId } = outcome;
      // Mutable across redos — see the reassignment note above.
      let entryId = outcome.entryId;

      record({
        label,
        undo: async () => {
          // A consumed entry (the user emptied the Trash dialog meanwhile) is a
          // typed 404 from the primitive; let it throw — the undo-redo store
          // wraps it as an UndoRedoThunkError. Never swallowed.
          await fetchEndpoint(restoreTrash, { sourceId, entryId });
          onUndo?.();
        },
        redo: async () => {
          const next = await trash();
          if (!next.trashed) {
            throw new Error(
              `Redo of "${label}" hard-deleted instead of trashing — the entity is gone and the history entry is no longer restorable.`,
            );
          }
          entryId = next.entryId;
        },
      });

      return outcome;
    },
    [record, fetchEndpoint],
  );
}
