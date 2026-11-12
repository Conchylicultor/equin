import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { MirrorRefusalSchema } from "@plugins/database/plugins/table-mirror/core";
import { HOST_QUERY_FAILURE_ARMS } from "@plugins/apps/plugins/deploy/plugins/host-query/core";

/** Where a replica's copy stands (table-mirror/replica's phases). */
export const MirrorPhaseSchema = z.enum([
  "empty",
  "copying",
  "reconciling",
  "live",
]);
export type MirrorPhase = z.infer<typeof MirrorPhaseSchema>;

/** Why a replica reconciles (table-mirror/replica's reasons). */
export const MirrorReconcileReasonSchema = z.enum([
  "behind-horizon",
  "source-identity",
  "source-fingerprints",
  "local-schema",
]);

/** Progress inside a copy or a reconcile, without the keys it stands at. */
export const MirrorProgressSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("tables"),
    tablesDone: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    rows: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    reason: MirrorReconcileReasonSchema.nullable(),
  }),
  z.object({
    stage: z.literal("stream"),
    reason: MirrorReconcileReasonSchema.nullable(),
  }),
]);
export type MirrorProgress = z.infer<typeof MirrorProgressSchema>;

/** Why a fetch from the box failed: host-query's failure, or the deployment gone. */
export const MirrorFetchFailureSchema = z.union([
  ...HOST_QUERY_FAILURE_ARMS,
  z.object({ kind: z.literal("not-found") }).strict(),
]);

/**
 * How the last pull ended. `refused`: the box answered a refusal the pull
 * cannot act on — `unknown-set` / `unknown-table` mean the site's release is
 * older than this computer's set (redeploy the site). `source-older`: the box
 * lacks a column this computer requires (redeploy too).
 */
export const MirrorOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("synced") }),
  z.object({ kind: z.literal("stopped") }),
  z.object({ kind: z.literal("refused"), refusal: MirrorRefusalSchema }),
  z.object({
    kind: z.literal("fetch-failed"),
    failure: MirrorFetchFailureSchema,
  }),
  z.object({
    kind: z.literal("source-older"),
    table: z.string(),
    columns: wholeList(z.string(), {
      reason: "the columns of one table this computer requires",
    }),
  }),
]);
export type MirrorOutcome = z.infer<typeof MirrorOutcomeSchema>;

/** One mirrored set of one deployment, as its freshness line reads it. */
export const SiteMirrorStatusSchema = z.object({
  setId: z.string(),
  phase: MirrorPhaseSchema,
  progress: MirrorProgressSchema.nullable(),
  /** A whole copy is in place: the copy is readable (older data stays readable through a failure). */
  copied: z.boolean(),
  /** When the change stream last reached the box's present (ISO). */
  lastSyncedAt: z.string().nullable(),
  /** The box's own clock at the last applied page (ISO): what the copy is "as of". */
  sourceNow: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastOutcome: MirrorOutcomeSchema.nullable(),
  /** A pull was asked for and has not ended yet. */
  pending: z.boolean(),
  /** The last pull job threw (a bug, reported as a failed job): its message. */
  runError: z.string().nullable(),
});
export type SiteMirrorStatus = z.infer<typeof SiteMirrorStatusSchema>;

/**
 * Every mirrored set of one deployment that this computer keeps a replica of
 * (one is created by the first sync asked for it). A set with no row was
 * never asked for.
 */
export const siteMirrorStatus = liveValue("site-mirror.status", {
  schema: wholeList(SiteMirrorStatusSchema, {
    reason: "one row per mirror set this computer declares — a handful",
  }),
  params: ["deploymentId"],
});

export const SiteMirrorSyncBodySchema = z
  .object({
    deploymentId: z.string(),
    /** One set (creating its replica on first ask), or every set already kept. */
    setId: z.string().optional(),
    /**
     * `open`: a tab showing the copy opened — pull only a copy that does not
     * exist yet or is older than a few minutes (the server decides, so a tab
     * never reacts to the status it reads). `refresh` (default): Sync now.
     */
    reason: z.enum(["open", "refresh"]).optional(),
  })
  .strict();

/**
 * Ask for a pull now: on a consumer's tab open (when the copy is a few minutes
 * old) and on Sync now. Enqueues the pull job; the status value says how it
 * went.
 */
export const siteMirrorSyncEndpoint = defineEndpoint({
  route: "POST /api/site-mirror/sync",
  body: SiteMirrorSyncBodySchema,
});
