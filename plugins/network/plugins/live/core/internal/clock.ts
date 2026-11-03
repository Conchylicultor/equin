import { z } from "zod";
import type { FieldDef } from "@plugins/fields/core";
import {
  wallClockToInstant,
  zoneWallClock,
} from "@plugins/packages/plugins/wall-clock/core";

// Reads against the clock — the one way a live read computes a value from the
// current time (research/2026-11-03-global-live-collections-item7-remaining.md,
// section A). Nothing live reads the clock itself: compiled SQL refuses
// `now()` / `current_date` (query-resource's `assertStableRead`) and a served
// loader may not call `Date.now()` / `new Date()` (lint
// `live/no-clock-in-served`). What may vary with time is declared here, as a
// CLOSED set of forms, and pinned by the READER:
//
// - a **clock field** (`clockField.elapsed(…)`) — a collection field computed
//   from the row's own inputs against `now`. Its value never travels: the row
//   carries the inputs, and the browser computes the value from this same
//   declaration (`clockFieldValue`) against its ticking clock. The server
//   renders the same form as SQL (`network/live/server`'s `clockFieldSql`)
//   only where a query names the field in `where` / `orderBy` — and then the
//   query carries a pinned `now` (epoch ms, floored to the field's quantum),
//   which the reader re-pins at the next quantum boundary with one timer.
// - a **clock param** (`clockParam.day()` / `clockParam.month({ zone })`) — a
//   value param the reader fills from its clock (today, this billing month)
//   and re-pins at the next boundary. The loader reads the param, never the
//   clock.
//
// Both renderings of a form (JS here, SQL on the server) switch exhaustively
// over `kind`: a new form is a type error in both until each renders it.

/** A clock field's form — the closed set. */
export type ClockForm = {
  readonly kind: "elapsed";
  /** The row field the span starts at (a `Date`). */
  readonly from: string;
  /** The row field the span ends at (a `Date`, `null` while open) — `now` stands in while it is `null`. */
  readonly until: string | null;
  /**
   * How finely a query that reads the field pins `now`, in ms: the reader
   * re-pins (a new tuple, the window reloads) once per quantum, and between
   * pins a still-open row's ticking cell may sit a little out of order.
   */
  readonly quantumMs: number;
};

const CLOCK_FORM = Symbol("network/live:clock-form");

/** What marks a field as declared against the clock (a row type leaves it out: it never travels). */
export type ClockBranded = { readonly [CLOCK_FORM]: ClockForm };

/** A field declared against the clock: its presentation is `field`'s, its value the form's. */
export type ClockFieldDef<T> = FieldDef<T> & ClockBranded;

function withForm<F extends FieldDef>(
  field: F,
  form: ClockForm,
): F & ClockBranded {
  if (!Number.isSafeInteger(form.quantumMs) || form.quantumMs < 1000) {
    throw new Error(
      `clockField.${form.kind}: quantumMs must be a whole number of ms, at least 1000 — got ${form.quantumMs}`,
    );
  }
  return Object.freeze({ ...field, [CLOCK_FORM]: form });
}

/** The clock forms a collection field may be declared with. */
export const clockField = {
  /**
   * Milliseconds from `from` to `until` — to `now` while `until` is `null`
   * (a run's "Took", ticking while it runs). `field` presents it (a duration
   * field, labelled); its value type is a number.
   */
  elapsed<F extends FieldDef<number> | FieldDef<number | null>>(
    field: F,
    spec: { from: string; until?: string; quantumMs: number },
  ): F & ClockBranded {
    return withForm(field, {
      kind: "elapsed",
      from: spec.from,
      until: spec.until ?? null,
      quantumMs: spec.quantumMs,
    });
  },
};

/** The clock form a field is declared with, or `null` for an ordinary field. */
export function clockFormOf(field: FieldDef): ClockForm | null {
  return (field as Partial<ClockFieldDef<unknown>>)[CLOCK_FORM] ?? null;
}

/** The row fields a form reads. */
export function clockInputs(form: ClockForm): readonly string[] {
  switch (form.kind) {
    case "elapsed":
      return form.until === null ? [form.from] : [form.from, form.until];
    default:
      return form.kind satisfies never;
  }
}

function instantOf(row: Record<string, unknown>, name: string): number | null {
  const v = row[name];
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  throw new Error(
    `clock field input "${name}" is not a Date (got ${typeof v}) — a clock form reads instants`,
  );
}

/**
 * The JS rendering of a form: its value on `row` at `nowMs` — what a cell
 * draws (against its ticking clock) and what a list compares by. The SQL
 * rendering (`clockFieldSql`, server) computes the same value against the
 * query's pinned `now`.
 */
export function clockFieldValue(
  form: ClockForm,
  row: object,
  nowMs: number,
): number | null {
  const r = row as Record<string, unknown>;
  switch (form.kind) {
    case "elapsed": {
      const from = instantOf(r, form.from);
      if (from === null) return null;
      const until = form.until === null ? null : instantOf(r, form.until);
      return (until ?? nowMs) - from;
    }
    default:
      return form.kind satisfies never;
  }
}

/**
 * Whether a form's value on `row` moves with the clock (an elapsed span still
 * open) — what a cell ticks for; a closed one is fixed whatever `now` is.
 */
export function clockFieldTicks(form: ClockForm, row: object): boolean {
  const r = row as Record<string, unknown>;
  switch (form.kind) {
    case "elapsed":
      return (
        instantOf(r, form.from) !== null &&
        (form.until === null || instantOf(r, form.until) === null)
      );
    default:
      return form.kind satisfies never;
  }
}

/** `nowMs` floored to `quantumMs` — the `now` a query pins. */
export function pinNow(nowMs: number, quantumMs: number): number {
  return Math.floor(nowMs / quantumMs) * quantumMs;
}

// ── Clock params ────────────────────────────────────────────────────────────

/** A clock param's form — the closed set. */
export type ClockParamForm =
  /** Today, `YYYY-MM-DD`, in the READER's zone (the browser's). */
  | { readonly kind: "day" }
  /** This month, `YYYY-MM`, in a fixed zone (a billing month). */
  | { readonly kind: "month"; readonly zone: string };

/** The wire schema of a clock param — its form attached. */
export type ClockParam = z.ZodString & { readonly clock: ClockParamForm };

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function param(schema: z.ZodString, form: ClockParamForm): ClockParam {
  return Object.assign(schema, { clock: form }) as ClockParam;
}

/**
 * The clock params a value may take (a typed param or a typed-query field):
 * the reader fills each from its clock (`useClockParam`) and re-pins it at
 * the next boundary; the loader reads it, never the clock.
 */
export const clockParam = {
  day: (): ClockParam => param(z.string().regex(DAY_RE), { kind: "day" }),
  month: (spec: { zone: string }): ClockParam =>
    param(z.string().regex(MONTH_RE), { kind: "month", zone: spec.zone }),
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** The browser's (or the process's) own zone. */
function readerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zoneOf(form: ClockParamForm): string {
  switch (form.kind) {
    case "day":
      return readerZone();
    case "month":
      return form.zone;
    default:
      return form satisfies never;
  }
}

/** A clock param's value at `now`, and the instant it next changes. */
export function clockParamAt(
  form: ClockParamForm,
  now: Date,
): { value: string; changesAt: Date } {
  const zone = zoneOf(form);
  const w = zoneWallClock(now, zone);
  switch (form.kind) {
    case "day": {
      // The next local midnight: the day after's wall clock, resolved in the
      // zone (a DST day is 23 or 25 hours long).
      const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
      return {
        value: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
        changesAt: wallClockToInstant(
          {
            year: next.getUTCFullYear(),
            month: next.getUTCMonth() + 1,
            day: next.getUTCDate(),
          },
          zone,
        ),
      };
    }
    case "month": {
      const next =
        w.month === 12
          ? { year: w.year + 1, month: 1 }
          : { year: w.year, month: w.month + 1 };
      return {
        value: `${w.year}-${pad(w.month)}`,
        changesAt: wallClockToInstant({ ...next, day: 1 }, zone),
      };
    }
    default:
      return form satisfies never;
  }
}
