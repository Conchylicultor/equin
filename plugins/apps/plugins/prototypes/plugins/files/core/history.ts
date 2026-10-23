import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { PrototypeOptionSchema } from "./prototypes";

// The wire half of a prototype's version history. The store itself (one private
// git repo per prototype, beside the folder) is Node-only and lives in
// `shared/history/`; this is what the browser reads of it.
//
// Design: `research/2026-09-11-apps-prototype-version-history.md`.

/**
 * Why a version exists.
 *
 * - `baseline` — v0: the folder as it was when its history began (the blank
 *   template for a freshly minted prototype, the state on adoption otherwise).
 * - `turn` — the end of an agent turn that changed the folder.
 * - `restore` — "Restored vN": an older version made live again.
 * - `manual` — `./singularity prototype checkpoint`, or the "Before restore"
 *   save a restore makes of unsaved changes.
 */
export const PROTOTYPE_VERSION_KINDS = [
  "baseline",
  "turn",
  "restore",
  "manual",
] as const;
export type PrototypeVersionKind = (typeof PROTOTYPE_VERSION_KINDS)[number];

/** One recorded version of a prototype — one commit in its history repo. */
export const PrototypeVersionSchema = z.object({
  /**
   * Position, oldest → newest: `0` is the baseline. Derived from the commit's
   * place in the history, never stored, so it cannot disagree with the order.
   */
  n: z.number().int(),
  /** Full commit sha — what addresses the version's files. */
  sha: z.string(),
  /** ISO-8601 commit time. */
  at: z.string(),
  kind: z.enum(PROTOTYPE_VERSION_KINDS),
  /** The commit's subject line: the request for a turn, "Restored v3", … */
  subject: z.string(),
  /** The conversation whose turn recorded it; `null` for every other kind. */
  conversationId: z.string().nullable(),
  /** The assistant message that ended that turn; `null` for every other kind. */
  messageId: z.string().nullable(),
  /**
   * The options THIS version's `index.html` declares — read out of the version
   * itself, never today's page: an option the live page has since dropped (or
   * not yet grown) is still pickable on the version that has it. Empty when it
   * declares none, or has no `index.html` (an empty folder's baseline).
   */
  options: z.array(PrototypeOptionSchema),
});
export type PrototypeVersion = z.infer<typeof PrototypeVersionSchema>;

/** A prototype's whole history, as the stepper reads it. */
export const PrototypeHistorySchema = z.object({
  /** Oldest → newest; `versions[i].n === i`. */
  versions: z.array(PrototypeVersionSchema),
  /**
   * The folder differs from the newest version — an edit no turn has recorded
   * yet (a hand edit, a plain terminal Claude). Shown as "Live · unsaved
   * changes" past the last version; folded into the next version recorded.
   */
  dirty: z.boolean(),
});
export type PrototypeHistory = z.infer<typeof PrototypeHistorySchema>;

/**
 * One prototype's history (push, a value per `name`). Served from the history
 * store (`source: "external"`) and re-broadcast when a version is recorded — by
 * any backend, since the store is host-global — and when the folder is edited,
 * which is what flips `dirty`. Pending until read: never an empty history
 * standing in for one not loaded yet.
 */
export const prototypeHistory = liveValue("prototypes.history", {
  schema: PrototypeHistorySchema,
  params: ["name"],
});

/** Version count per prototype id — at least 1 (every history has its `v0`). */
export const PrototypeVersionCountsSchema = z.record(
  z.string(),
  z.number().int().positive(),
);

/**
 * How many versions each prototype has, keyed by prototype id (push) — the
 * gallery's "v12" token, without subscribing to every prototype's whole
 * history. Read from each history repo's newest-version stamp, so the read is
 * one small file per prototype. A prototype missing from the map has no count
 * known (no history yet, or one recorded before the stamp existed) — the token
 * is omitted, never drawn as `0`. Bounded by the prototype list it annotates.
 * Notified by the watcher whenever any history records a version.
 */
export const prototypeVersionCounts = liveValue("prototypes.versionCounts", {
  schema: PrototypeVersionCountsSchema,
});

/**
 * Make an older version live again: saves unsaved changes first (a `manual`
 * "Before restore" version), writes the old files back, and records a
 * `restore` version "Restored vN" — which is what it answers with. Nothing is
 * ever lost. 404 for an unknown prototype or a sha that is not one of its
 * versions.
 */
export const restorePrototypeVersion = defineEndpoint({
  route: "POST /api/prototypes/:name/versions/:sha/restore",
  response: PrototypeVersionSchema,
});
