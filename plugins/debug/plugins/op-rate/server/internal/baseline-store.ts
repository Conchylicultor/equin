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
 * windows outnumber the regime's (usualCallsOf throws on that); an op's hour
 * row is written no later than its bucket, so its history (from its first
 * called hour, readHistory) always holds every window its buckets count.
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
  // An op's hour is written no later than its bucket (in the same statement,
  // or the one before): an op's history starts at its first called hour
  // (readHistory), so a bucket must never exist without that hour.
  const [first, ...rest] = chunked(called);
  await writeAtomically(exec, [
    exec
      .insert(w)
      .values({ regime, hourStart, windows: 1 })
      .onConflictDoUpdate({
        target: [w.regime, w.hourStart],
        set: { windows: sql`${w.windows} + 1` },
      }),
    first === undefined ? null : insertHours(first),
    first === undefined ? null : insertCounts(first),
  ]);
  for (const chunk of rest) {
    await insertHours(chunk);
    await insertCounts(chunk);
  }
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
  /** Every window of the regime over the span, whatever op was called. */
  windows: number;
  /**
   * Each asked op's history, from its first called hour in the span on (see
   * firstCalledHours); an op never called in it has no windows and no buckets.
   */
  ops: ReadonlyMap<string, OpHistory>;
}

/**
 * The first hour (epoch ms) each op was called in, over the span — where its
 * history starts. Before it the op did not exist under that name (a changed
 * SQL text is a new `db` label; a new resource a new key): counting those
 * hours as "not called" would make a young op's usual rate that of whatever
 * hours of the day it has lived through, and judge its first busy hour as a
 * jump from them (2026-11-17: a renamed upsert, born at noon, read 1,125
 * calls/h at 11:00 next day as 25× its quiet evening hours).
 */
function firstCalledHours(
  rows: readonly { op: string; dayStart: Date; calls: readonly number[] }[],
): Map<string, number> {
  const first = new Map<string, number>();
  for (const r of rows) {
    const hour = r.calls.findIndex((n) => n > 0);
    if (hour < 0) continue;
    const at = r.dayStart.getTime() + hour * HOUR_MS;
    const prev = first.get(r.op);
    if (prev === undefined || at < prev) first.set(r.op, at);
  }
  return first;
}

/** The day-hour rows of `ops` over the span. */
function readDayHours(
  exec: DbExecutor,
  ops: readonly string[],
  span: { from: Date; until: Date },
) {
  const h = _opRateDayHours;
  return exec
    .select({ op: h.op, dayStart: h.dayStart, calls: h.calls })
    .from(h)
    .where(
      and(
        opIn(h.op, ops),
        gte(h.dayStart, span.from),
        lt(h.dayStart, span.until),
      ),
    );
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
  const span = baselineSpan(atMs);
  const { from, until } = span;
  const w = _opRateWindows;
  const hourRows = await exec
    .select({ hourStart: w.hourStart, windows: w.windows })
    .from(w)
    .where(
      and(eq(w.regime, regime), gte(w.hourStart, from), lt(w.hourStart, until)),
    );
  const windowsSince = (atOrAfter: number) =>
    hourRows.reduce(
      (sum, r) => (r.hourStart.getTime() >= atOrAfter ? sum + r.windows : sum),
      0,
    );
  const windows = windowsSince(-Infinity);
  const buckets = new Map<string, Map<number, number>>(
    ops.map((op) => [op, new Map()]),
  );
  let firstCalled = new Map<string, number>();
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
    firstCalled = firstCalledHours(await readDayHours(exec, ops, span));
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
    ops: new Map(
      [...buckets].map(([op, b]) => {
        const since = firstCalled.get(op);
        return [
          op,
          {
            windows: since === undefined ? 0 : windowsSince(since),
            buckets: b,
          },
        ];
      }),
    ),
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
      /**
       * One entry per covered past hour from the op's first called hour on
       * (firstCalledHours), 0 where it was not called. Empty for an op never
       * called in the span.
       */
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
  const firstCalled = new Map<string, number>();
  if (over.length > 0) {
    const rows = await readDayHours(
      exec,
      over.map(([op]) => op),
      { from, until },
    );
    for (const [op, first] of firstCalledHours(rows))
      firstCalled.set(op, first);
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
          pastHours: hours
            .filter((at) => at >= (firstCalled.get(op) ?? Infinity))
            .map((at) => past.get(op)?.get(at) ?? 0),
        },
      ]),
    ),
  };
}
