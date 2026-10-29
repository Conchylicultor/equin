import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

// Auto-resume: an agent a usage limit stopped is sent the resume turn once an
// account it would launch on has room again — when the limit that stopped it
// resets. One job (the machine's `runtime-sdk.auto-resume`) re-derives the
// plan below at every run and sleeps until the next time it names.

export const autoResumeConfig = defineConfig({
  name: "runtime-sdk-auto-resume",
  fields: {
    enabled: boolField({
      default: false,
      label: "Resume agents when their usage limit resets",
      description:
        "An agent stopped by its Claude account's usage limit is sent “Continue from where you left off.” as soon as the limit resets — or right away on another account, when auto-switch finds one with room.",
    }),
  },
});

/** After the reset Claude Code reports, a margin before the resume turn: its clock and ours. */
export const AUTO_RESUME_MARGIN_MS = 60_000;

/**
 * How long after a stop an agent waits when no reading says its limit is
 * still reached — a stop the usage reading never caught up with. Bounds a
 * resume that keeps hitting the limit to one turn per wait.
 */
export const AUTO_RESUME_RETRY_MS = 2 * 60_000;

export interface AutoResumePlan {
  /** The conversations to send the resume turn now. */
  resumeNow: string[];
  /** When to plan again (epoch ms), or `null` when nothing is left waiting. */
  nextAt: number | null;
}

/**
 * Which usage-limit-stopped conversations to resume now, and when to look
 * again. `limit`: the limit reached now on the account an agent restarted now
 * would launch on (`limitReached`), or `null` when it has room.
 */
export function planAutoResume(opts: {
  stopped: readonly { id: string; stoppedAt: number }[];
  limit: { resetsAt: number } | null;
  now: number;
}): AutoResumePlan {
  const { stopped, limit, now } = opts;
  if (stopped.length === 0) return { resumeNow: [], nextAt: null };
  if (limit) {
    return { resumeNow: [], nextAt: limit.resetsAt + AUTO_RESUME_MARGIN_MS };
  }
  const resumeNow: string[] = [];
  let nextAt: number | null = null;
  for (const { id, stoppedAt } of stopped) {
    const dueAt = stoppedAt + AUTO_RESUME_RETRY_MS;
    if (dueAt <= now) resumeNow.push(id);
    else nextAt = nextAt === null ? dueAt : Math.min(nextAt, dueAt);
  }
  return { resumeNow, nextAt };
}
