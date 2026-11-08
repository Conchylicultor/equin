import { z } from "zod";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import { CrashTailSchema } from "./kind";

/** One death of a crash loop (gateway `loopDeath`). */
export const LoopDeathSchema = z.strictObject({
  /** Epoch ms it died. */
  at: z.number(),
  /** How long that process lived. */
  upMs: z.number(),
  /** `exit 1`, `SIGSEGV`. */
  cause: z.string(),
  /** It had passed its readiness probe: it died serving, not booting. */
  ready: z.boolean(),
});
export type LoopDeath = z.infer<typeof LoopDeathSchema>;

/**
 * The most deaths a loop entry lists (gateway `crashLoopRecentDeaths`); its
 * `deaths` count is the whole loop's.
 */
export const CRASH_LOOP_RECENT_DEATHS = 20;

// The jsonb payload of a `backend-crash-loop` report: a worktree whose backend
// keeps dying — `threshold` deaths or more, each within `windowMs` of the
// previous. A summary ON TOP of each death's own report (`backend-crash`,
// `backend-exit`), never instead of them. Written by the GATEWAY (Go,
// gateway/exit_report.go `backendCrashLoop`) when the loop reaches the
// threshold, each time its count doubles, and once when it ends;
// gateway/testdata/backend-crash-loop-entry.json pins the contract
// (loop-kind.test.ts). Strict.
export const BackendCrashLoopPayloadSchema = z.strictObject({
  worktree: z.string(),
  /** `looping` while it dies; `ended` once `windowMs` passed with no death. */
  state: z.enum(["looping", "ended"]),
  /** How many times it died in this loop so far. */
  deaths: z.number().int().positive(),
  firstDeathAt: z.number(),
  lastDeathAt: z.number(),
  /** Epoch ms the loop was declared over; null while looping. */
  endedAt: z.number().nullable(),
  /**
   * The worktree's backend state when it was declared over — `running`: it
   * stayed up; `idle` / `broken`: nothing restarted it. Null while looping.
   */
  stateAtEnd: z.string().nullable(),
  windowMs: z.number(),
  threshold: z.number().int(),
  /** The newest deaths, oldest first. */
  recent: z.array(LoopDeathSchema).min(1).max(CRASH_LOOP_RECENT_DEATHS),
  /** The last death's stderr tail — what it died saying. */
  lastStderrTail: CrashTailSchema,
  lastStderrComplete: z.boolean(),
});
export type BackendCrashLoopPayload = z.infer<
  typeof BackendCrashLoopPayloadSchema
>;

/** The causes seen in the listed deaths, most frequent first: `exit 1 ×18, SIGSEGV ×2`. */
export function loopCausesOf(d: BackendCrashLoopPayload): string {
  const counts = new Map<string, number>();
  for (const x of d.recent) counts.set(x.cause, (counts.get(x.cause) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cause, n]) => `${cause} ×${n}`)
    .join(", ");
}

/** One line: `main is crash-looping: 12 deaths in 1m 40s (exit 1)`. */
export function describeBackendCrashLoop(d: BackendCrashLoopPayload): string {
  const span = formatDuration(d.lastDeathAt - d.firstDeathAt);
  const last = d.recent[d.recent.length - 1];
  const tail = `${d.deaths} deaths in ${span} (last: ${last?.cause ?? "?"})`;
  return d.state === "looping"
    ? `${d.worktree} is crash-looping: ${tail}`
    : `${d.worktree} crash-looped: ${tail}; quiet since, now ${d.stateAtEnd ?? "?"}`;
}
