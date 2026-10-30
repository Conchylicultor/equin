import { and, eq } from "drizzle-orm";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { TrashEntry } from "../../core";
import { trashEntryIdKind } from "../../core";
import { getTrashSource, type TrashSource } from "./registry";
import type { TrashExecutor } from "./record-entry";
import { _trashEntries } from "./tables";

/**
 * Shared restore/purge skeleton: resolve the source (unknown source id = LOUD
 * throw — a config error, the source plugin isn't mounted — never a 404), load
 * the entry (`HttpError(404)` if gone — failure is a type, a double
 * restore/purge from a second tab must surface, never silently no-op), run the
 * source-side action, THEN delete the ledger row.
 *
 * Action-before-delete ordering is deliberate: if `restore`/`purge` throws, the
 * entry row survives and the operation is retryable; deleting first would
 * strand the domain rows with no handle to them. The `trashEntries` live
 * collection needs no hand-notify — the L4 change-feed on `trash_entries`
 * moves its windows when the row insert/delete commits.
 *
 * `dbx` is any drizzle executor (global handle, tx, or a test fixture's
 * throwaway DB) so the lifecycle is testable against a real scratch database.
 */
export async function consumeTrashEntry(
  dbx: TrashExecutor,
  params: { sourceId: string; entryId: string },
  action: (source: TrashSource, entry: TrashEntry) => Promise<void>,
): Promise<{ ok: true }> {
  const source = getTrashSource(params.sourceId);
  if (!source) {
    throw new Error(
      `[trash] no trash source registered for "${params.sourceId}" — is the source plugin mounted?`,
    );
  }

  const [row] = await dbx
    .select()
    .from(_trashEntries)
    .where(
      and(
        // `key` upgrades a bare uuid a pre-rewrite undo stack still holds.
        eq(_trashEntries.id, trashEntryIdKind.key(params.entryId)),
        eq(_trashEntries.sourceId, params.sourceId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, "Trash entry not found");

  await action(source, row);

  await dbx.delete(_trashEntries).where(eq(_trashEntries.id, row.id));

  return { ok: true as const };
}
