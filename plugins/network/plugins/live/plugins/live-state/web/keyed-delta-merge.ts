// Pure merge core for keyed-delta sync. Extracted from `NotificationsClient`
// so the one load-bearing invariant — *the assembled array never contains a
// hole* — is named, isolated, and fuzzable without standing up a socket or a
// QueryClient.
//
// Background: a keyed array resource rebroadcasts only changed rows. On a
// membership/order change the server ships the authoritative `order` (the full
// id list) plus `upserts` (only the rows whose content changed). The client
// rebuilds the array from `order`, reusing its own cached row objects for ids
// the server didn't resend — so memoized rows keep their reference and don't
// re-render.
//
// The trap that made this worth extracting: if `order` names an id that is in
// *neither* `upserts` *nor* the client's cached base, the row is unknowable.
// The old code resolved that to `undefined` and wrote it straight into the
// array, punching a hole that crashed the next consumer to iterate the rows.
// That state is real — it's *base drift*: a missed or stale-dropped
// intermediate frame left the client's base behind the server snapshot the
// delta was diffed against. The correct response is not to guess but to signal
// drift so the caller can force a fresh full base (resub).

export type KeyedDeltaResult =
  // Clean merge. `rows` is hole-free; unchanged ids keep their prior object
  // reference.
  | { readonly kind: "merged"; readonly rows: readonly unknown[] }
  // Base drift: `order` referenced ids resolvable from neither the upserts nor
  // the cached base. Caller must discard the delta and resub for a full base.
  // `missingIds` is non-empty.
  | { readonly kind: "drift"; readonly missingIds: readonly string[] };

/**
 * Merge a row-keyed delta into the prior cached array. Pure: no I/O, no cache,
 * no socket. `upsertMap` holds the already-parsed changed rows keyed by id
 * (parsing stays with the caller, which owns the schema).
 *
 * - `order === undefined` ⇒ in-place upserts only (membership unchanged): walk
 *   the prior array swapping changed rows by id. Cannot add, delete, or
 *   reorder, and cannot drift — an upsert for an id absent from the base is
 *   simply ignored (the server only omits `order` when membership is unchanged).
 * - `order` present ⇒ rebuild from the authoritative id list, reusing prior row
 *   references for ids the server didn't resend. Any `order` id unresolvable
 *   from `upsertMap ∪ base` ⇒ `{ kind: "drift" }`.
 */
export function mergeKeyedDelta(
  prevRows: readonly unknown[],
  upsertMap: ReadonlyMap<string, unknown>,
  order: readonly string[] | undefined,
  keyOf: (row: unknown) => string,
): KeyedDeltaResult {
  if (order === undefined) {
    return {
      kind: "merged",
      rows: prevRows.map((row) => upsertMap.get(keyOf(row)) ?? row),
    };
  }
  const existingById = new Map<string, unknown>();
  for (const row of prevRows) existingById.set(keyOf(row), row);
  const rows: unknown[] = [];
  const missingIds: string[] = [];
  for (const rowId of order) {
    const row = upsertMap.get(rowId) ?? existingById.get(rowId);
    if (row === undefined) {
      missingIds.push(rowId);
      continue;
    }
    rows.push(row);
  }
  if (missingIds.length > 0) return { kind: "drift", missingIds };
  return { kind: "merged", rows };
}
