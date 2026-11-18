import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/** The most watched repos the status lists (three today). */
export const WATCHED_REPOS_MAX = 50;

/**
 * Where one repo's forwarder stands.
 *
 * - `connecting`   — started, GitHub has not pinged it yet.
 * - `connected`    — GitHub pinged it: deliveries flow.
 * - `reconnecting` — it exited; the daemon respawns it (`detail`: why it died).
 * - `failed`       — it kept dying at once and the daemon gave up (`detail`).
 */
export const ForwarderStateSchema = z.enum([
  "connecting",
  "connected",
  "reconnecting",
  "failed",
]);
export type ForwarderState = z.infer<typeof ForwarderStateSchema>;

export const ForwarderStatusSchema = z.object({
  repo: z.string(),
  state: ForwarderStateSchema,
  /** The forwarder's last words (its stderr, or the daemon's), when it has any. */
  detail: z.string().nullable(),
  /** When it entered `state` (ISO). */
  since: z.string(),
});
export type ForwarderStatus = z.infer<typeof ForwarderStatusSchema>;

/**
 * GitHub events on this backend, as the health row reads it.
 *
 * - `off`        — not the publisher (a clone, or any backend but main's):
 *                  no forwarder runs here, the row is absent.
 * - `not-set-up` — the publisher, but a forwarder cannot start: `reason`
 *                  says what is missing, `fix` the command that fixes it.
 * - `on`         — one forwarder per watched repo, each with its state.
 */
export const GitHubEventsStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off") }),
  z.object({
    kind: z.literal("not-set-up"),
    reason: z.string(),
    fix: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("on"),
    forwarders: cappedList(ForwarderStatusSchema, { max: WATCHED_REPOS_MAX }),
  }),
]);
export type GitHubEventsStatus = z.infer<typeof GitHubEventsStatusSchema>;

/** The live forwarder status, pushed on every state change. */
export const githubEventsStatus = liveValue("github-events.status", {
  schema: GitHubEventsStatusSchema,
  needsMachine: { feature: "GitHub events" },
});
