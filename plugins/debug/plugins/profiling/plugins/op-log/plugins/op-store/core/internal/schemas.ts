import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import {
  WAIT_KINDS,
  type OpFoldState,
  type OpSleep,
  type OpSleepStamp,
  type OpStep,
  type OpWait,
  type OpenWait,
  type TerminalOutcome,
  type WaitKind,
  type WaitResult,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import type { Lane } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { OP_KIND_IDS } from "@plugins/infra/plugins/worktree/core";

// The wire shape of one `op_log_ops` row, and the zod schemas that decode its
// enum and jsonb columns. Every schema here is pinned to the op-log type it
// mirrors by a type-level equality below, so the store cannot drift from the
// reducer it persists.

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/** The wait kinds, as a tuple `z.enum` takes. Derived from `WAIT_KINDS`. */
export const WAIT_KIND_IDS = Object.keys(WAIT_KINDS) as [
  WaitKind,
  ...WaitKind[],
];

export const WAIT_RESULTS = [
  "acquired",
  "cleared",
  "fail-open",
  "aborted",
] as const satisfies readonly WaitResult[];

/** Every terminal outcome any kind may report (the union of `OutcomeByKind`). */
export const TERMINAL_OUTCOMES = [
  "success",
  "failed",
  "error",
  "failed_rebase",
  "failed_checks",
  "failed_push",
] as const satisfies readonly TerminalOutcome[];

export const LANES = [
  "interactive",
  "background",
] as const satisfies readonly Lane[];

export const PUSH_MODES = ["worktree", "from-main"] as const;

/**
 * Who closed a stored op. The reducer's two (`self`, `reconciler`) plus the
 * store's own: `ingest-gap` — a worktree backend's ingester lost part of the log
 * (its cursor's file rotated away) and closed a dead op locally, because the
 * terminal main's reconciler appended may be in the part it never read.
 */
export const STORE_CLOSED_BY = ["self", "reconciler", "ingest-gap"] as const;
export type StoreClosedBy = (typeof STORE_CLOSED_BY)[number];

export const OpKindSchema = z.enum(OP_KIND_IDS);
export const WaitKindSchema = z.enum(WAIT_KIND_IDS);
export const WaitResultSchema = z.enum(WAIT_RESULTS);
export const TerminalOutcomeSchema = z.enum(TERMINAL_OUTCOMES);
export const LaneSchema = z.enum(LANES);
export const PushModeSchema = z.enum(PUSH_MODES);
export const StoreClosedBySchema = z.enum(STORE_CLOSED_BY);

export const OpWaitSchema = z.object({
  kind: WaitKindSchema,
  startMs: z.number(),
  durationMs: z.number(),
  reason: z.string().nullable(),
  cycle: z.number(),
  result: WaitResultSchema.nullable(),
  // The wall extent; absent on a legacy wait.
  atMs: z.number().optional(),
  wallMs: z.number().optional(),
});

export const OpenWaitSchema = z.object({
  kind: WaitKindSchema,
  startMs: z.number(),
  startedAt: z.string(),
  reason: z.string().nullable(),
  cycle: z.number(),
});

export const OpStepSchema = z.object({
  name: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
});

export const OpSleepSchema = z.object({
  startMs: z.number(),
  durationMs: z.number(),
  approx: z.boolean(),
});

export const OpSleepStampSchema = z.object({
  boot: z.string(),
  asleepMs: z.number(),
  atMs: z.number(),
});

/**
 * One op, as `op_log_ops` stores it and both live collections serve it: the
 * reducer's `OpFoldState` flattened onto columns (identity spread, instants as
 * dates), plus `closedWaitMs` — the sum of the CLOSED waits. The time spent in
 * the open wait is not stored: it grows with `now`, so a reader computes it
 * with `liveTimes(opRowToFoldState(row), now)`.
 */
/** The fields both collections LIST (and filter by), in the row's own order. */
export const OP_ROW_LISTED = {
  kind: enumTextField(OP_KIND_IDS, { label: "Kind" }),
  /** `basename(worktree root)` of the checkout the op ran in. */
  opSlug: nullable(textField({ label: "Worktree" })),
  requestedAt: dateField({ label: "Requested" }),
  /** `null` while in flight — and for a reconciler close (a killed op has no end). */
  completedAt: nullable(dateField({ label: "Completed" })),
  /** `null` while in flight. */
  outcome: nullable(enumTextField(TERMINAL_OUTCOMES, { label: "Outcome" })),
};

/** Every other key of the row: on the wire, in no list, never filterable. */
export const OP_ROW_CARRIED = {
  opId: textField(),
  branch: textField(),
  conversationId: nullable(textField()),
  lane: nullable(parsedTextField(LaneSchema, { default: "interactive" })),
  mode: nullable(parsedTextField(PushModeSchema, { default: "worktree" })),
  buildId: nullable(textField()),
  /** The CLI process that ran it; `null` for a legacy (pre-v2) op. */
  pid: nullable(intField()),
  grantedAt: nullable(dateField()),
  interrupted: boolField(),
  /** Non-null ⇔ terminal. THE in-flight predicate (`completedAt` is not one). */
  closedBy: nullable(parsedTextField(StoreClosedBySchema, { default: "self" })),
  /** Closed waits, in order. */
  waits: jsonField({ schema: z.array(OpWaitSchema), default: [] }),
  /** The wait the op is parked in right now; `null` when working or closed. */
  openWait: nullable(
    jsonField({ schema: OpenWaitSchema, default: {} as OpenWait }),
  ),
  /** Current (or final) requeue cycle. */
  cycle: intField(),
  /** `sum(waits.durationMs)` — closed waits only. */
  closedWaitMs: floatField(),
  holdMs: floatField(),
  totalMs: floatField(),
  steps: jsonField({ schema: z.array(OpStepSchema), default: [] }),
  /** Highest v2 `seq` applied; 0 for a legacy op. */
  lastSeq: intField(),
  /**
   * Sleeps folded so far (wall axis, ms after `requestedAt`); `[]` for an op
   * from a writer without sleep stamps — and for every row stored before the
   * column existed (its DB default).
   */
  sleeps: jsonField({ schema: z.array(OpSleepSchema), default: [] }),
  /** The last sleep stamp applied — where the next sleep's gap starts. */
  sleepStamp: nullable(
    jsonField({ schema: OpSleepStampSchema, default: {} as OpSleepStamp }),
  ),
};
export const OpRowSchema = fieldsToZodObject({
  ...OP_ROW_CARRIED,
  ...OP_ROW_LISTED,
});
export type OpRow = z.infer<typeof OpRowSchema>;

// Pin the jsonb schemas to the reducer's types, both directions.
export type _PinWait = Assert<Equal<z.infer<typeof OpWaitSchema>, OpWait>>;
export type _PinOpenWait = Assert<
  Equal<z.infer<typeof OpenWaitSchema>, OpenWait>
>;
export type _PinStep = Assert<Equal<z.infer<typeof OpStepSchema>, OpStep>>;
export type _PinSleep = Assert<Equal<z.infer<typeof OpSleepSchema>, OpSleep>>;
export type _PinSleepStamp = Assert<
  Equal<z.infer<typeof OpSleepStampSchema>, OpSleepStamp>
>;
export type _PinOutcome = Assert<
  Equal<(typeof TERMINAL_OUTCOMES)[number], TerminalOutcome>
>;
export type _PinLane = Assert<Equal<(typeof LANES)[number], Lane>>;
export type _PinWaitResult = Assert<
  Equal<(typeof WAIT_RESULTS)[number], WaitResult>
>;

/**
 * A stored row back as the reducer's state — what the ingester applies the next
 * line to, and what a surface hands `liveTimes` / `toOpRecord`.
 *
 * `ingest-gap` reads back as `reconciler`: to the reducer both are "closed by
 * someone other than the op", and a closed state is never applied to again.
 */
export function opRowToFoldState(row: OpRow): OpFoldState {
  return {
    opId: row.opId,
    identity: {
      kind: row.kind,
      opSlug: row.opSlug,
      branch: row.branch,
      conversationId: row.conversationId,
      lane: row.lane,
      mode: row.mode,
      buildId: row.buildId,
      pid: row.pid,
    },
    requestedAt: row.requestedAt.toISOString(),
    grantedAt: row.grantedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    waits: row.waits,
    openWait: row.openWait,
    cycle: row.cycle,
    lastSeq: row.lastSeq,
    closedBy:
      row.closedBy === null
        ? null
        : row.closedBy === "self"
          ? "self"
          : "reconciler",
    outcome: row.outcome,
    interrupted: row.interrupted,
    holdMs: row.holdMs,
    totalMs: row.totalMs,
    steps: row.steps,
    sleeps: row.sleeps,
    sleepStamp: row.sleepStamp,
  };
}
