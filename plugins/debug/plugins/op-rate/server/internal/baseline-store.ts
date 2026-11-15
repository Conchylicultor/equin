import { and, eq, gte, lt, sql, type Column } from "drizzle-orm";
import { writeAtomically, type DbExecutor } from "@plugins/database/server";
import type { OpRateRegime } from "../../core";
import {
  BASELINE_DAYS,
  bucketOf,
  HOUR_MS,
  MIN_WINDOWS_PER_HOUR,
  utcDayStart,
  utcHourStart,
  type OpHistory,
} from "./op-rate-baseline";
import { _opRateDayBuckets, _opRateDayHours, _opRateWindows } from "./tables";

const DAY_MS = 24 * HOUR_MS;

// Rows per INSERT, under Postgres's 65,535 bind parameters per statement (4 per
// bucket row, 3 per hour row). A backend's labels are not bounded: every
// distinct SQL text is a `db` label.
const ROWS_PER_INSERT = 10_000;

function chunked<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT)
    chunks.push(rows.slice(i, i + ROWS_PER_INSERT));
  return chunks;
}

/** An array of `length` zeros but `value` at its last index. */
function lastSlot(length: number, value: number): number[] {
  const slots = new Array<number>(length).fill(0);
  slots[length - 1] = value;
  return slots;
}

/**
 * The stored counter array plus the inserted one, element by element (the
 * shorter padded with zeros): the ON CONFLICT update of a per-day counter row.
 */
function addSlots(stored: Column) {
  return sql`(SELECT array_agg(coalesce(a, 0) + coalesce(b, 0) ORDER BY i) FROM unnest(${stored}, excluded.${sql.identifier(stored.name)}) WITH ORDINALITY AS u(a, b, i))`;
}

/**
 * Add one judged window to the history, at `atMs` (the window's middle, so a
 * window closed on the hour counts in the hour it covered): the regime's window
 * count for the hour, each op called in it to its bucket for the day, and its
 * calls to its hour of the day. The window count is written in the same
 * statement as the first chunk of ops, so a reader can never see an op's
 * windows outnumber the regime's (usualCallsOf throws on that).
 */
export async function recordWindow(
  exec: DbExecutor,
  regime: OpRateRegime,
  atMs: number,
  calls: ReadonlyMap<string, number>,
): Promise<void> {
  const dayStart = utcDayStart(atMs);
  const hourStart = utcHourStart(atMs);
  const hourOfDay = (hourStart.getTime() - dayStart.getTime()) / HOUR_MS;
  const called = [...calls].filter(([, n]) => n > 0);
  const w = _opRateWindows;
  const c = _opRateDayBuckets;
  const h = _opRateDayHours;
  const insertCounts = (rows: readonly (readonly [string, number])[]) =>
    exec
      .insert(c)
      .values(
        rows.map(([op, n]) => ({
          op,
          regime,
          dayStart,
          windows: lastSlot(bucketOf(n) + 1, 1),
        })),
      )
      .onConflictDoUpdate({
        target: [c.op, c.regime, c.dayStart],
        set: { windows: addSlots(c.windows) },
      });
  const insertHours = (rows: readonly (readonly [string, number])[]) =>
    exec
      .insert(h)
      .values(
        rows.map(([op, n]) => ({
          op,
          dayStart,
          calls: lastSlot(hourOfDay + 1, n),
        })),
      )
      .onConflictDoUpdate({
        target: [h.op, h.dayStart],
        set: { calls: addSlots(h.calls) },
      });
  const [first, ...rest] = chunked(called);
  await writeAtomically(exec, [
    exec
      .insert(w)
      .values({ regime, hourStart, windows: 1 })
      .onConflictDoUpdate({
        target: [w.regime, w.hourStart],
        set: { windows: sql`${w.windows} + 1` },
      }),
    first === undefined ? null : insertCounts(first),
  ]);
  for (const chunk of rest) await insertCounts(chunk);
  for (const chunk of chunked(called)) await insertHours(chunk);
}

/**
 * `op` is one of `ops`, as ONE array parameter whatever their number — so the
 * statement is one `db` label, not one per list length.
 */
function opIn(op: Column, ops: readonly string[]) {
  return sql`${op} = ANY(${sql.param([...ops])}::text[])`;
}

/** The BASELINE_DAYS whole UTC days before `atMs`'s day: [from, until). */
function baselineSpan(atMs: number): { from: Date; until: Date } {
  const until = utcDayStart(atMs);
  return { from: new Date(until.getTime() - BASELINE_DAYS * DAY_MS), until };
}

/** A regime's window history over the baseline span. */
export interface RegimeHistory {
  windows: number;
  /** Each asked op's history; an op never called in it has empty buckets. */
  ops: ReadonlyMap<string, OpHistory>;
}

/**
 * The window history of `ops` in `regime`. Today is left out: a loop that
 * started today is judged against the days before it, never against itself.
 */
export async function readHistory(
  exec: DbExecutor,
  regime: OpRateRegime,
  atMs: number,
  ops: readonly string[],
): Promise<RegimeHistory> {
  const { from, until } = baselineSpan(atMs);
  const [total] = await exec
    .select({
      windows: sql`coalesce(sum(${_opRateWindows.windows}), 0)::int`.mapWith(
        Number,
      ),
    })
    .from(_opRateWindows)
    .where(
      and(
        eq(_opRateWindows.regime, regime),
        gte(_opRateWindows.hourStart, from),
        lt(_opRateWindows.hourStart, until),
      ),
    );
  if (total === undefined)
    throw new Error("op-rate: an aggregate read returned no row");
  const { windows } = total;
  const buckets = new Map<string, Map<number, number>>(
    ops.map((op) => [op, new Map()]),
  );
  if (ops.length > 0) {
    const t = _opRateDayBuckets;
    const rows = await exec
      .select({ op: t.op, windows: t.windows })
      .from(t)
      .where(
        and(
          opIn(t.op, ops),
          eq(t.regime, regime),
          gte(t.dayStart, from),
          lt(t.dayStart, until),
        ),
      );
    for (const r of rows) {
      const opBuckets = buckets.get(r.op);
      if (opBuckets === undefined)
        throw new Error(`op-rate: history answered an op not asked: ${r.op}`);
      r.windows.forEach((n, bucket) => {
        if (n > 0) opBuckets.set(bucket, (opBuckets.get(bucket) ?? 0) + n);
      });
    }
  }
  return {
    windows,
    ops: new Map([...buckets].map(([op, b]) => [op, { windows, buckets: b }])),
  };
}

/** Ops whose hour so far passed a floor, with their past hours. */
export interface HourHistory {
  /** Past hours over the baseline span with enough windows to be a sample. */
  coveredHours: number;
  ops: ReadonlyMap<
    string,
    {
      /** Calls in `atMs`'s hour: those recorded, plus this window's. */
      hourSoFar: number;
      /** One entry per covered past hour, 0 where the op was not called. */
      pastHours: readonly number[];
    }
  >;
}

/**
 * The ops of this window (`windowCalls`, not yet recorded) whose calls so far
 * in `atMs`'s hour pass `floor`, with their past hours over the baseline span
 * (today left out, like readHistory).
 */
export async function readHourHistory(
  exec: DbExecutor,
  atMs: number,
  windowCalls: ReadonlyMap<string, number>,
  floor: number,
): Promise<HourHistory> {
  const { from, until } = baselineSpan(atMs);
  const dayStart = utcDayStart(atMs);
  const hourOfDay =
    (utcHourStart(atMs).getTime() - dayStart.getTime()) / HOUR_MS;
  const h = _opRateDayHours;
  const recorded = await exec
    .select({ op: h.op, calls: h.calls })
    .from(h)
    .where(and(eq(h.dayStart, dayStart), opIn(h.op, [...windowCalls.keys()])));
  const soFar = new Map(windowCalls);
  for (const r of recorded)
    soFar.set(r.op, (soFar.get(r.op) ?? 0) + (r.calls[hourOfDay] ?? 0));
  const over = [...soFar].filter(([, n]) => n > floor);
  const w = _opRateWindows;
  const covered = await exec
    .select({ hourStart: w.hourStart })
    .from(w)
    .where(and(gte(w.hourStart, from), lt(w.hourStart, until)))
    .groupBy(w.hourStart)
    .having(sql`sum(${w.windows}) >= ${MIN_WINDOWS_PER_HOUR}`);
  const hours = covered.map((r) => r.hourStart.getTime());
  const coveredAt = new Set(hours);
  const past = new Map<string, Map<number, number>>(
    over.map(([op]) => [op, new Map()]),
  );
  if (over.length > 0) {
    const rows = await exec
      .select({ op: h.op, dayStart: h.dayStart, calls: h.calls })
      .from(h)
      .where(
        and(
          opIn(
            h.op,
            over.map(([op]) => op),
          ),
          gte(h.dayStart, from),
          lt(h.dayStart, until),
        ),
      );
    for (const r of rows) {
      const opPast = past.get(r.op);
      if (opPast === undefined)
        throw new Error(
          `op-rate: hour history answered an op not asked: ${r.op}`,
        );
      r.calls.forEach((n, hour) => {
        const at = r.dayStart.getTime() + hour * HOUR_MS;
        if (coveredAt.has(at)) opPast.set(at, n);
      });
    }
  }
  return {
    coveredHours: hours.length,
    ops: new Map(
      over.map(([op, hourSoFar]) => [
        op,
        {
          hourSoFar,
          pastHours: hours.map((at) => past.get(op)?.get(at) ?? 0),
        },
      ]),
    ),
  };
}
