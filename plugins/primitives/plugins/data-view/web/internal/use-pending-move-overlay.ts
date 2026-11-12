import { useMemo, useState, type ReactNode } from "react";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { ManualOrderConfig, SectionMove } from "../../core";

/**
 * A drop whose write is still in flight: the rank the row was dropped at, and
 * the rank the PRODUCER reported for it at drop time. The producer's rank moving
 * off `baseline` is the signal that its own order (a push, or its optimistic
 * overlay) now carries the move, so this one steps aside.
 */
export interface PendingMove {
  readonly rank: Rank;
  readonly baseline: Rank | null;
}

export type PendingMoves = ReadonlyMap<string, PendingMove>;

/** A pending row's producer rank now — or `present: false` once it left the rows. */
export type CurrentRank =
  { present: false } | { present: true; rank: Rank | null };

const NO_PENDING_MOVES: PendingMoves = new Map();

function sameRank(a: Rank | null, b: Rank | null): boolean {
  if (a === null || b === null) return a === b;
  return Rank.equals(a, b);
}

/**
 * Pure clear rule: a pending move is done once its row is gone, or once the
 * producer's rank for it stopped equalling the drop-time `baseline`.
 */
export function shouldClear(move: PendingMove, current: CurrentRank): boolean {
  if (!current.present) return true;
  return !sameRank(current.rank, move.baseline);
}

/**
 * Record a drop. Keyed by row id: a second drop of the same row before the
 * first one landed REPLACES the entry (the latest drop is what the user sees).
 */
export function applyPendingMove<T>(
  pending: ReadonlyMap<string, T>,
  id: string,
  move: T,
): ReadonlyMap<string, T> {
  return new Map(pending).set(id, move);
}

/**
 * Drop `id`'s entry — but only if it is still `move`. A rejection of an earlier
 * drop must not clear a later drop of the same row that replaced it.
 */
export function releasePendingMove<T>(
  pending: ReadonlyMap<string, T>,
  id: string,
  move: T,
): ReadonlyMap<string, T> {
  if (pending.get(id) !== move) return pending;
  const next = new Map(pending);
  next.delete(id);
  return next;
}

/**
 * Remove every entry `shouldClear` says is done. Returns `pending` ITSELF when
 * nothing cleared, so the caller can compare identities to know whether to store.
 */
export function prunePendingMoves(
  pending: PendingMoves,
  current: (id: string) => CurrentRank,
): PendingMoves {
  let next: Map<string, PendingMove> | null = null;
  for (const [id, move] of pending) {
    if (!shouldClear(move, current(id))) continue;
    next ??= new Map(pending);
    next.delete(id);
  }
  return next ?? pending;
}

/** The rank to render a row at: its pending drop rank, else the producer's. */
export function overlayRank(
  pending: PendingMoves,
  id: string,
  underlying: Rank | null,
): Rank | null {
  return pending.get(id)?.rank ?? underlying;
}

/**
 * A cross-section drop whose `onReseat` write is still in flight: where the
 * row is drawn (`move`), and the row's group-by value at drop time, spelled
 * (`spellGroupValue`). The value moving off `baseline` is the producer's own
 * data carrying the move, so the hold steps aside.
 */
export interface PendingReseat {
  readonly move: SectionMove;
  readonly baseline: string;
}

export type PendingReseats = ReadonlyMap<string, PendingReseat>;

const NO_PENDING_RESEATS: PendingReseats = new Map();

/** A group-by value as one comparable spelling (`null` / absent its own). */
export function spellGroupValue(value: unknown): string {
  if (value == null) return "\u0000none";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A held row's group-by value now — or `present: false` once it left the rows. */
export type CurrentGroupValue =
  { present: false } | { present: true; value: string };

/**
 * Remove every held reseat that is done: its row gone, or its group-by value
 * off the drop-time baseline. `pending` itself when nothing cleared.
 */
export function prunePendingReseats(
  pending: PendingReseats,
  current: (id: string) => CurrentGroupValue,
): PendingReseats {
  let next: Map<string, PendingReseat> | null = null;
  for (const [id, held] of pending) {
    const now = current(id);
    if (now.present && now.value === held.baseline) continue;
    next ??= new Map(pending);
    next.delete(id);
  }
  return next ?? pending;
}

interface RowIndex<TRow> {
  rowById: Map<string, TRow>;
  idByRow: Map<TRow, string>;
}

function indexRows<TRow>(
  rows: readonly TRow[],
  rowKey: (row: TRow, index: number) => string,
): RowIndex<TRow> {
  const rowById = new Map<string, TRow>();
  const idByRow = new Map<TRow, string>();
  rows.forEach((row, i) => {
    const id = rowKey(row, i);
    rowById.set(id, row);
    idByRow.set(row, id);
  });
  return { rowById, idByRow };
}

/**
 * No snap-back on drop. The moment a drop lands the view clears its drag
 * transforms; a producer whose ranks only move when the server push arrives
 * (e.g. view-order) would show the row back in its old slot for that round
 * trip, then jump forward. This wraps the effective `ManualOrderConfig` once, for
 * every producer:
 *
 * - `onMove` reads the row's producer rank as `baseline`, calls the real
 *   `onMove`, and — only when it returned a promise (a write in flight) —
 *   records `{ rank: dest.rank, baseline }`. A synchronous return means nothing
 *   is in flight: the producer already applied its order or legitimately did
 *   nothing (a no-op drop), so
 *   holding an overlay would only risk pinning a stale rank.
 * - `getRank` returns the pending rank for that row, so the section ordering
 *   renders the new order on the drop frame.
 * - An entry clears when the producer's rank moves off `baseline`, when the row
 *   disappears, or when the promise rejects. The rejection is rethrown on the
 *   returned promise, never absorbed — the producer's own error path still
 *   surfaces it.
 *
 * Several quick drops of DIFFERENT rows are independent entries. A re-drop of
 * the SAME row replaces its entry; if the first drop's push then lands, it moves
 * the producer rank off the (shared) baseline and clears the re-drop's overlay
 * early — the row may show the first drop's slot until the second push. That
 * degrades to the pre-overlay behaviour, never to a wrong final order.
 *
 * `onReseat` (a cross-section drop) is held the same way, by section rather
 * than rank: with `groupValue` given and a promise returned, the move is kept
 * as a `SectionMove` the view applies (`heldReseats`) until the row's group-by
 * value moves off its drop-time value, the row leaves, or the promise rejects.
 *
 * `dest.rank` is computed against the RENDERED rows. That is right for display
 * (the row lands between the rows the user saw); producers keep minting their
 * own ranks.
 */
export function usePendingMoveOverlay<TRow>(
  config: ManualOrderConfig<TRow> | undefined,
  rows: readonly TRow[],
  rowKey: (row: TRow, index: number) => string,
  /** The group-by field's value of a row — absent when the view is not
   *  grouped, where no drop crosses sections. */
  groupValue?: (row: TRow) => unknown,
): PendingOverlay<TRow> {
  const [pending, setPending] = useState<PendingMoves>(NO_PENDING_MOVES);
  const [reseats, setReseats] = useState<PendingReseats>(NO_PENDING_RESEATS);
  // `rowKey` is an inline arrow at the consumer's call site; the stable identity
  // keeps the memos below keyed on the data, not on a closure's identity.
  const stableRowKey = useEventCallback(rowKey);

  // The id ↔ row index costs a pass over the rows, so it only exists while a
  // move is pending — an idle DataView pays nothing.
  const hasPending = pending.size > 0 || reseats.size > 0;
  const index = useMemo(
    () => (hasPending ? indexRows(rows, stableRowKey) : null),
    [hasPending, rows, stableRowKey],
  );

  // While a sort shadows the manual order there is no producer rank to compare
  // against; entries wait for the config to come back.
  const live = useMemo(() => {
    if (index === null || config === undefined) return pending;
    return prunePendingMoves(pending, (id): CurrentRank => {
      const row = index.rowById.get(id);
      return row === undefined
        ? { present: false }
        : { present: true, rank: config.getRank(row) };
    });
  }, [pending, index, config]);
  // Adjust-state-during-render: `live` is derived from the current rows, and
  // storing it stops a cleared entry from reviving if the producer's rank ever
  // returns to `baseline`. `prunePendingMoves` returns the same identity when
  // nothing cleared, so the re-render this schedules settles immediately.
  if (live !== pending) setPending(live);
  // The held reseats, cleared the same way off the row's group-by value.
  const liveReseats = useMemo(() => {
    if (index === null || groupValue === undefined) return reseats;
    return prunePendingReseats(reseats, (id): CurrentGroupValue => {
      const row = index.rowById.get(id);
      return row === undefined
        ? { present: false }
        : { present: true, value: spellGroupValue(groupValue(row)) };
    });
  }, [reseats, index, groupValue]);
  if (liveReseats !== reseats) setReseats(liveReseats);
  const heldReseats = useMemo(
    () => [...liveReseats.values()].map((held) => held.move),
    [liveReseats],
  );

  const wrapped = useMemo(() => {
    if (config === undefined) return undefined;
    const onReseat = config.onReseat;
    return {
      ...config,
      getRank: (row: TRow) => {
        const underlying = config.getRank(row);
        if (index === null) return underlying;
        const id = index.idByRow.get(row);
        return id === undefined
          ? underlying
          : overlayRank(live, id, underlying);
      },
      onMove: (id, dest) => {
        const i = rows.findIndex((row, j) => stableRowKey(row, j) === id);
        const baseline = i === -1 ? undefined : config.getRank(rows[i]!);
        const result = config.onMove(id, dest);
        if (result === undefined || baseline === undefined) return result;
        const move: PendingMove = { rank: dest.rank, baseline };
        setPending((prev) => applyPendingMove(prev, id, move));
        return result.then(undefined, (err: unknown) => {
          setPending((prev) => releasePendingMove(prev, id, move));
          throw err;
        });
      },
      // A cross-section drop holds its row in the destination section until
      // the row's group-by value moves — the same rule as `onMove`'s rank, and
      // only while a write is in flight (a promise) under a group-by.
      onReseat:
        onReseat === undefined
          ? undefined
          : (id, dest) => {
              const i = rows.findIndex((row, j) => stableRowKey(row, j) === id);
              const result = onReseat(id, dest);
              if (result === undefined || i === -1 || groupValue === undefined)
                return result;
              const held: PendingReseat = {
                move: { id, dest },
                baseline: spellGroupValue(groupValue(rows[i]!)),
              };
              setReseats((prev) => applyPendingMove(prev, id, held));
              return result.then(undefined, (err: unknown) => {
                setReseats((prev) => releasePendingMove(prev, id, held));
                throw err;
              });
            },
    } satisfies ManualOrderConfig<TRow>;
  }, [config, index, live, rows, stableRowKey, groupValue]);
  return { config: wrapped, heldReseats };
}

/** What the overlay hands the view: the wrapped config, and the rows held in
 *  another section while their `onReseat` write is in flight. */
export interface PendingOverlay<TRow> {
  config: ManualOrderConfig<TRow> | undefined;
  heldReseats: readonly SectionMove[];
}

/**
 * Render-prop host for `usePendingMoveOverlay`, for call sites that only learn
 * the config inside a callback (the `RowOrder` fold's children) and so cannot
 * call a hook there.
 */
export function PendingMoveOverlay<TRow>({
  config,
  rows,
  rowKey,
  groupValue,
  children,
}: {
  config: ManualOrderConfig<TRow> | undefined;
  rows: readonly TRow[];
  rowKey: (row: TRow, index: number) => string;
  groupValue?: (row: TRow) => unknown;
  children: (overlay: PendingOverlay<TRow>) => ReactNode;
}): ReactNode {
  return children(usePendingMoveOverlay(config, rows, rowKey, groupValue));
}
