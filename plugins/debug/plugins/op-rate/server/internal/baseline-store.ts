import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, writeAtomically } from "@plugins/database/server";
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
import {
  _opRateHourCalls,
  _opRateWindowCounts,
  _opRateWindows,
} from "./tables";

const DAY_MS = 24 * HOUR_MS;

// Rows per INSERT, under Postgres's 65,535 bind parameters per statement (5 per
// window-count row, 3 per hour row). A backend's labels are not bounded: every
// distinct SQL text is a `db` label.
const ROWS_PER_INSERT = 10_000;

function chunked<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT)
    chunks.push(rows.slice(i, i + ROWS_PER_INSERT));
  return chunks;
}

/**
 * Add one judged window to the history, at `atMs` (the window's middle, so a
 * window closed on the hour counts in the hour it covered): the regime's window
 * count for the hour, each op called in it to its bucket for the day, and its
 * calls to its hour. The window count is written in the same statement as the
 * first chunk of ops, so a reader can never see an op's windows outnumber the
 * regime's (usualCallsOf throws on that).
 */
export async function recordWindow(
  regime: OpRateRegime,
  atMs: number,
  calls: ReadonlyMap<string, number>,
): Promise<void> {
  const dayStart = utcDayStart(atMs);
  const hourStart = utcHourStart(atMs);
  const called = [...calls].filter(([, n]) => n > 0);
  const w = _opRateWindows;
  const c = _opRateWindowCounts;
  const h = _opRateHourCalls;
  const insertCounts = (rows: readonly (readonly [string, number])[]) =>
    db
      .insert(c)
      .values(
        rows.map(([op, n]) => ({
          op,
          regime,
          dayStart,
          bucket: bucketOf(n),
          windows: 1,
        })),
      )
      .onConflictDoUpdate({
        target: [c.op, c.regime, c.dayStart, c.bucket],
        set: { windows: sql`${c.windows} + 1` },
      });
  const insertHours = (rows: readonly (readonly [string, number])[]) =>
    db
      .insert(h)
      .values(rows.map(([op, n]) => ({ op, hourStart, calls: n })))
      .onConflictDoUpdate({
        target: [h.op, h.hourStart],
        set: { calls: sql`${h.calls} + excluded.calls` },
      });
  const [first, ...rest] = chunked(called);
  await writeAtomically(db, [
    db
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
  regime: OpRateRegime,
  atMs: number,
  ops: readonly string[],
): Promise<RegimeHistory> {
  const { from, until } = baselineSpan(atMs);
  const [total] = await db
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
    const t = _opRateWindowCounts;
    const rows = await db
      .select({
        op: t.op,
        bucket: t.bucket,
        windows: sql`sum(${t.windows})::int`.mapWith(Number),
      })
      .from(t)
      .where(
        and(
          inArray(t.op, [...ops]),
          eq(t.regime, regime),
          gte(t.dayStart, from),
          lt(t.dayStart, until),
        ),
      )
      .groupBy(t.op, t.bucket);
    for (const r of rows) buckets.get(r.op)?.set(r.bucket, r.windows);
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

/** `op` is one of `ops`, as ONE array parameter whatever their number. */
function opIn(op: typeof _opRateHourCalls.op, ops: readonly string[]) {
  return sql`${op} = ANY(${sql.param([...ops])}::text[])`;
}

/**
 * The ops of this window (`windowCalls`, not yet recorded) whose calls so far
 * in `atMs`'s hour pass `floor`, with their past hours over the baseline span
 * (today left out, like readHistory).
 */
export async function readHourHistory(
  atMs: number,
  windowCalls: ReadonlyMap<string, number>,
  floor: number,
): Promise<HourHistory> {
  const { from, until } = baselineSpan(atMs);
  const hourStart = utcHourStart(atMs);
  const h = _opRateHourCalls;
  const recorded = await db
    .select({ op: h.op, calls: h.calls })
    .from(h)
    .where(
      and(eq(h.hourStart, hourStart), opIn(h.op, [...windowCalls.keys()])),
    );
  const soFar = new Map(windowCalls);
  for (const r of recorded) soFar.set(r.op, (soFar.get(r.op) ?? 0) + r.calls);
  const over = [...soFar].filter(([, n]) => n > floor);
  const w = _opRateWindows;
  const covered = await db
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
    const rows = await db
      .select({ op: h.op, hourStart: h.hourStart, calls: h.calls })
      .from(h)
      .where(
        and(
          opIn(
            h.op,
            over.map(([op]) => op),
          ),
          gte(h.hourStart, from),
          lt(h.hourStart, until),
        ),
      );
    for (const r of rows) {
      const at = r.hourStart.getTime();
      if (coveredAt.has(at)) past.get(r.op)?.set(at, r.calls);
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
