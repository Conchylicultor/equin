import { z } from "zod";

/** How often central probes every running backend. */
export const PROBE_EVERY_MS = 15_000;
/** How long one probe waits for any HTTP answer. */
export const PROBE_TIMEOUT_MS = 5_000;
/**
 * Observed-awake time a backend must stay unanswered before it is frozen. A
 * minute is far past any legitimate event-loop stall (stall-monitor reports
 * those from inside, in seconds) and still reports a freeze within ~1 min.
 */
export const FROZEN_AFTER_MS = 60_000;
/** While a backend stays frozen, it is re-reported this often. */
export const HEARTBEAT_MS = 60_000;

/**
 * How an episode stands:
 * - `frozen` — the latest probe got no answer (re-filed every HEARTBEAT_MS);
 * - `answered` — it answered again: its thread ran;
 * - `exited` — its process is gone, or the gateway no longer runs it;
 * - `paused` — its process was stopped (SIGSTOP, a debugger): deliberate.
 */
export const EpisodeStateSchema = z.enum([
  "frozen",
  "answered",
  "exited",
  "paused",
]);
export type EpisodeState = z.infer<typeof EpisodeStateSchema>;

// The jsonb payload of a `backend-frozen` report, filed by central through the
// report outbox. The row's own `worktree` column is main's (main drains the
// outbox), so the frozen backend's worktree lives here and in the fingerprint
// (`backend-frozen:<worktree>`).
export const BackendFrozenPayloadSchema = z.object({
  worktree: z.string(),
  /** The backend process — a restart is a new process, so a new episode. */
  pid: z.number(),
  /** Wall ms of the first unanswered probe: the freeze began at or just before. */
  sinceMs: z.number(),
  /** Observed-awake time unanswered (machine sleep never counts). */
  unansweredMs: z.number(),
  state: EpisodeStateSchema,
  /** Wall ms of the probe this report reflects. */
  observedMs: z.number(),
});
export type BackendFrozenPayload = z.infer<typeof BackendFrozenPayloadSchema>;

/** A duration the way a report reads it: `45s`, `12m`, `5.5h`. */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
