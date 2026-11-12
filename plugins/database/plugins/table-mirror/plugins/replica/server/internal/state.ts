import { z } from "zod";
import {
  MirrorLogPositionSchema,
  MirrorPkSchema,
  MirrorRefusalSchema,
} from "@plugins/database/plugins/table-mirror/core";

// A replica's state, as the `table_mirror_replicas` row stores it.

/** Where the copy stands. Readers get data only once it is past `copying`. */
export const REPLICA_PHASES = [
  "empty",
  "copying",
  "reconciling",
  "live",
] as const;
export const ReplicaPhaseSchema = z.enum(REPLICA_PHASES);
export type ReplicaPhase = z.infer<typeof ReplicaPhaseSchema>;

/** Where the copy keeps the rows: its own schema (same DDL), or a custom sink (the key index only). */
export const ReplicaSinkKindSchema = z.enum(["schema", "custom"]);
export type ReplicaSinkKind = z.infer<typeof ReplicaSinkKindSchema>;

/** Why deltas could not be trusted, so the replica reconciles. */
export const ReconcileReasonSchema = z.enum([
  "behind-horizon",
  "source-identity",
  "source-fingerprints",
  "local-schema",
]);
export type ReconcileReason = z.infer<typeof ReconcileReasonSchema>;

/**
 * Progress inside a phase. `tables`: walking the set's tables in order (a copy
 * by `readMirrorCopy`, a reconcile by `readMirrorKeys`), `table` the current
 * one and `afterPk` the last key done in it. `stream`: the tables are done and
 * the change stream runs from the pass's floor until `done`.
 */
export const ReplicaProgressSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("tables"),
    table: z.string(),
    afterPk: MirrorPkSchema.nullable(),
    /** Tables finished, of `total`. */
    tablesDone: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    /** Rows applied (copy) or fetched as different (reconcile). */
    rows: z.number().int().nonnegative(),
    /** Local keys the source no longer has, deleted (reconcile). */
    deleted: z.number().int().nonnegative(),
    reason: ReconcileReasonSchema.nullable(),
  }),
  z.object({
    stage: z.literal("stream"),
    reason: ReconcileReasonSchema.nullable(),
  }),
]);
export type ReplicaProgress = z.infer<typeof ReplicaProgressSchema>;

/**
 * How the last pull ended. `stopped`: its page budget ran out with the replica
 * not caught up (the caller pulls again). `refused` / `fetch-failed`: the
 * source answered a refusal the pull cannot act on, or the transport failed
 * (opaque, as the transport gave it). `source-older`: the source lacks a
 * column this computer's table requires (NOT NULL, no default) — deploy the
 * site again.
 */
export const ReplicaOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("synced") }),
  z.object({ kind: z.literal("stopped") }),
  z.object({ kind: z.literal("refused"), refusal: MirrorRefusalSchema }),
  z.object({ kind: z.literal("fetch-failed"), failure: z.unknown() }),
  z.object({
    kind: z.literal("source-older"),
    table: z.string(),
    columns: z.array(z.string()),
  }),
]);
export type ReplicaOutcome = z.infer<typeof ReplicaOutcomeSchema>;

export const ReplicaAfterSchema = MirrorLogPositionSchema;
