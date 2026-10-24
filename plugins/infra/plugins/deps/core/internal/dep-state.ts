import { z } from "zod";

/** How many of an install log's last lines an `installing` state carries. */
export const DEP_LOG_TAIL_LINES = 20;

/**
 * Where one declared dependency stands on this machine, for its CURRENT
 * identity (the one this checkout's declaration derives today):
 *
 * - `absent` — nothing installed at this identity. An interrupted install (its
 *   process died before writing `ready.json`) reads as absent too: the only
 *   definition of "installed" is `ready.json`.
 * - `installing` — an install holds the host lock right now. `logTail` is the
 *   end of its log.
 * - `ready` — installed; `bytes` is the size on disk, `lastUsed` the last
 *   `ensureDep` that found it.
 * - `failed` — the last install at this identity threw, or the identity itself
 *   cannot be derived (the installer is missing). Installing again retries.
 */
export const DepStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({
    kind: z.literal("installing"),
    since: z.string(),
    logTail: z.array(z.string()).max(DEP_LOG_TAIL_LINES),
  }),
  z.object({
    kind: z.literal("ready"),
    identity: z.string(),
    bytes: z.number().int().nonnegative(),
    lastUsed: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("failed"),
    message: z.string(),
    at: z.string(),
  }),
]);
export type DepState = z.infer<typeof DepStateSchema>;

/**
 * How a dependency stays current: moved by a named updater (the `uv` updater
 * moves every `python/` project's `uv.lock`), or frozen, with the reason —
 * so being frozen is a visible decision, never an omission.
 */
export const DepUpdatesSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("updater"), updater: z.string() }),
  z.object({ kind: z.literal("none"), reason: z.string() }),
]);
export type DepUpdates = z.infer<typeof DepUpdatesSchema>;

/** One declared dependency, as the Dependencies view lists it. */
export const DepRowSchema = z.object({
  id: z.string(),
  /** The declaring plugin's path, e.g. `infra/audio-analysis`. */
  owner: z.string(),
  description: z.string(),
  /** A human estimate of the install's size, e.g. `≈40 MB`. */
  sizeHint: z.string(),
  /** The installer kind (`python`, …). */
  kind: z.string(),
  /** What the kind installs from, e.g. the uv project's path. */
  source: z.string(),
  updates: DepUpdatesSchema,
  state: DepStateSchema,
});
export type DepRow = z.infer<typeof DepRowSchema>;
