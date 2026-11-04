import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import {
  db,
  writeAtomically,
  type AtomicWrite,
} from "@plugins/database/server";
import type { RunEventAction } from "../../core";
import { planReanchor } from "./plan-reanchor";
import { _events } from "./tables";

// THE ONLY sanctioned write path to `events`.
//
// `updated_at` is derived by a DB
// trigger from the counted columns, so no writer here or elsewhere stamps it.
// The funnel owns the rest of the row's lifecycle instead: the sighting stamps
// (`firstSeenAt` / `lastSeenAt`), soft disappearance, and the three write
// shapes below. The barrel therefore exports the events table as a READ handle
// (`eventsTable`) plus the writers below, and the `events/no-raw-events-write`
// lint rule fails any `db.insert/update/delete(eventsTable)` outside this file.
//
// The three functions below are the only write SHAPES performed on `events`:
// the extraction diff ("upsert → stamp disappearedAt") plus the re-anchor that
// keeps a recurring row's occurrence projection current as time passes.
// Everything else about refreshing — externalId derivation, the run ledger,
// error classification, scheduling — is the `refresh` plugin's, and is
// deliberately not here.

/**
 * One event as the engine hands it over: every column except the row-lifecycle
 * and sighting stamps (this module owns the sighting stamps; the DB owns
 * `createdAt` defaults and derives `updatedAt`). Derived from the table's insert
 * type, so adding a field to `eventFields` updates this by construction.
 */
export type EventWriteInput = Omit<
  typeof _events.$inferInsert,
  "firstSeenAt" | "lastSeenAt" | "disappearedAt" | "createdAt" | "updatedAt"
>;

/**
 * One event this write touched, and how. The engine turns these into the run's
 * `event_source_run_events` rows — which is why they are RETURNED rather than
 * written here: this module owns the `events` write and nothing else, and the
 * link rows must land in the run ledger's own transaction to be atomic with the
 * run row that explains them.
 */
export interface TouchedEvent {
  eventId: string;
  action: RunEventAction;
}

export interface UpsertEventsResult {
  created: number;
  updated: number;
  /** Every input row, in input order — `created.length + updated.length`. */
  touched: TouchedEvent[];
}

/**
 * Upsert a batch against the unique `(source_id, external_id)` identity: a row
 * the source has not produced before is inserted, one it has is refreshed in
 * place (and un-disappeared, since the source is vouching for it again).
 *
 * Re-extraction is therefore idempotent — running it twice over an unchanged
 * page produces `created: 0` and touches only the sighting stamps.
 *
 * One statement per row inside a single transaction: an extraction is tens of
 * events, and the per-row form keeps the update set derived from the input keys
 * (so a new field cannot be silently dropped on the conflict path). If a source
 * type ever produces thousands of rows, batch this into a multi-row
 * `excluded.*` upsert — do not move the write out of this module.
 */
export async function upsertEvents(
  inputs: readonly EventWriteInput[],
): Promise<UpsertEventsResult> {
  if (inputs.length === 0) return { created: 0, updated: 0, touched: [] };

  return db.transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    const touched: TouchedEvent[] = [];

    for (const input of inputs) {
      const now = new Date();
      // Identity columns are never part of the conflict-path update: they ARE
      // the conflict target. Everything else the caller supplied is refreshed.
      const {
        id: _id,
        sourceId: _sourceId,
        externalId: _externalId,
        ...content
      } = input;

      const [row] = await tx
        .insert(_events)
        .values({
          ...input,
          firstSeenAt: now,
          lastSeenAt: now,
          disappearedAt: null,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [_events.sourceId, _events.externalId],
          set: {
            ...content,
            lastSeenAt: now,
            // The source listed it again, so it is no longer gone.
            disappearedAt: null,
          },
        })
        // `xmax = 0` on the returned tuple is true exactly for a fresh INSERT.
        // The id comes back from the DB rather than from `input.id`, because on
        // the conflict path the surviving row is the EXISTING one — its id, not
        // the one this run minted for a row it did not insert.
        .returning({
          id: _events.id,
          inserted: sql`(xmax = 0)`.mapWith(Boolean),
        });

      if (!row) {
        throw new Error(
          `[events] upsert returned no row for (${input.sourceId}, ${input.externalId})`,
        );
      }
      if (row.inserted) created += 1;
      else updated += 1;
      touched.push({
        eventId: row.id,
        action: row.inserted ? "created" : "updated",
      });
    }

    return { created, updated, touched };
  });
}

/**
 * Soft-disappearance: stamp every not-already-disappeared event of this source
 * that a SUCCESSFUL FULL extraction did not list. Returns the stamped events —
 * the ids, not just a count, because the run that stamped them records which
 * ones (the count on the run row is `.length` of this).
 *
 * Only ever call this after a run that genuinely enumerated the whole source —
 * a partial or failed extraction must not reach here, or a flaky scrape marks
 * the user's whole list gone. Rows are never deleted, so a subsequent
 * successful run un-disappears them via `upsertEvents`.
 */
export async function markEventsDisappeared(
  sourceId: string,
  seenExternalIds: readonly string[],
): Promise<TouchedEvent[]> {
  const now = new Date();
  const stillPresent = isNull(_events.disappearedAt);
  const rows = await db
    .update(_events)
    .set({ disappearedAt: now })
    .where(
      seenExternalIds.length === 0
        ? // The source successfully listed nothing: everything it had is gone.
          // (`notInArray` with an empty list is not valid SQL, hence the branch.)
          and(eq(_events.sourceId, sourceId), stillPresent)
        : and(
            eq(_events.sourceId, sourceId),
            stillPresent,
            notInArray(_events.externalId, [...seenExternalIds]),
          ),
    )
    .returning({ id: _events.id });
  return rows.map((row) => ({ eventId: row.id, action: "disappeared" }));
}

/** What one re-anchor pass did. Counts, not ids: nothing consumes the rows. */
export interface ReanchorResult {
  /** Recurring rows examined — every one of them, see below. */
  checked: number;
  /** …of those, the ones whose stored anchor was not the right occurrence. */
  moved: number;
  /** …of those, the series that are simply over (no occurrence left). */
  exhausted: number;
}

/** Start of `t`'s LOCAL day — the granularity every date filter compares at. */
function startOfLocalDay(t: Date): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Rows moved per statement: 4 bind parameters each, well under 65,535. */
const REANCHOR_MOVES_PER_STATEMENT = 1_000;

/**
 * Move every recurring row's occurrence projection forward to its next
 * occurrence as of `now`.
 *
 * `events.date` is the authority and does not decay: it carries the rule plus
 * the anchor the extractor stated, so the next occurrence is derivable from it
 * at any instant. The `startsAt` / `endsAt` / `allDay` COLUMNS are the
 * denormalized answer for one instant — the one the extraction ran at — because
 * the list filters, sorts and keyset-paginates on plain indexed columns rather
 * than digging into jsonb. That answer expires the moment the occurrence it
 * names passes.
 *
 * So the columns are maintained derived state, and this is the maintainer.
 * Without it a weekly event keeps claiming to start on the last day it was
 * scraped, and every "upcoming" view — a `startsAt >= today` filter — silently
 * drops a series that is still running. That is not hypothetical: it is what
 * made six live weekly events invisible on the Events list, and it gets worse
 * the longer a source goes without a re-extraction (a manual-refresh source
 * goes without one indefinitely).
 *
 * EVERY recurring row is examined, not just the ones whose anchor has visibly
 * passed. The invariant being restored is "`startsAt` is the occurrence at or
 * after the start of today", and a row can violate it in both directions — an
 * anchor too far FORWARD (a bad extraction, or a sweep that once resolved at
 * the wall clock and skipped an all-day occurrence) is invisible to a
 * `startsAt < today` candidate query, so such a query can only ratchet and
 * never converge. Checking all of them costs one indexed read of a set bounded
 * by the recurring events, and `planReanchor` answers `keep` for the ones
 * already right, so a correct pass still writes nothing.
 *
 * Deliberately NOT limited: a cap would leave the remainder stale, which is the
 * exact bug this closes.
 *
 * A series with no occurrence left is left ALONE rather than stamped or
 * deleted. Its last anchor is the honest answer to "when does this happen" —
 * it happened, and it is over — and falling out of an "upcoming" filter is
 * then correct rather than a symptom.
 *
 * Disappeared rows are re-anchored too: the column means the same thing on
 * every row, and a row the source stops listing is hidden by the query's own
 * default rather than by a lie in its date.
 */
export async function reanchorRecurringEvents(
  now: Date,
): Promise<ReanchorResult> {
  // ONE notion of "current" for the whole pass, and it is the DAY — the unit the
  // filters this column feeds compare at. An occurrence that started earlier
  // today is still today's, so resolving at the wall clock instead would skip it
  // and hide a series from the day it is running on.
  const today = startOfLocalDay(now);

  const rows = await db
    .select({
      id: _events.id,
      date: _events.date,
      startsAt: _events.startsAt,
    })
    .from(_events)
    .where(eq(_events.recurring, true));

  if (rows.length === 0) return { checked: 0, moved: 0, exhausted: 0 };

  let moved = 0;
  let exhausted = 0;

  const moves: AtomicWrite[] = [];
  for (const row of rows) {
    const plan = planReanchor(row.date, row.startsAt, today);
    if (plan.kind === "over") {
      exhausted += 1;
      continue;
    }
    if (plan.kind === "keep") continue;

    moves.push(
      db
        .update(_events)
        .set({
          startsAt: plan.occurrence.startsAt,
          endsAt: plan.occurrence.endsAt,
          allDay: plan.occurrence.allDay,
        })
        .where(eq(_events.id, row.id)),
    );
    moved += 1;
  }
  // The moves as statements of up to REANCHOR_MOVES_PER_STATEMENT rows each
  // (one arm per row): the plan is computed above, so nothing is read between
  // the writes, and no moved row stays locked across an app round trip. Each
  // statement is atomic on its own, which is all the pass needs — a row's move
  // depends on that row alone, and a pass that dies midway is finished by the
  // next one.
  for (let i = 0; i < moves.length; i += REANCHOR_MOVES_PER_STATEMENT) {
    await writeAtomically(db, moves.slice(i, i + REANCHOR_MOVES_PER_STATEMENT));
  }

  return { checked: rows.length, moved, exhausted };
}
