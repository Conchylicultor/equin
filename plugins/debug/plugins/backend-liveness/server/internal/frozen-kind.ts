import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { logsDirFor } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import {
  BackendFrozenPayloadSchema,
  FROZEN_AFTER_MS,
  humanMs,
  type BackendFrozenPayload,
} from "../../core";

// A frozen backend is a live outage: re-arm the bell every ~15 min while it
// lasts (each minute's re-file bumps `count`).
const NOTIF_COOLDOWN_MS = 15 * 60 * 1000;

// The `backend-frozen` kind, filed by central's liveness probe through the
// report outbox. One row per WORKTREE (the row's own worktree is main, which
// drains the outbox), so repeated freezes of one backend collapse
// and `count` says how many minutes / episodes it was seen frozen.
export const backendFrozenKind = ReportKind({
  kind: "backend-frozen",
  schema: BackendFrozenPayloadSchema,
  fingerprint: (d: BackendFrozenPayload) => `backend-frozen:${d.worktree}`,
  meta: {
    tag: "[backend-frozen]",
    notif: "Backend stopped answering",
    variant: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = BackendFrozenPayloadSchema.parse(row.data);
    return {
      title: `[backend-frozen] ${d.worktree} did not answer for ${humanMs(d.unansweredMs)}`,
      description: renderDescription(row, d),
    };
  },
});

const STATE_WORDS: Record<BackendFrozenPayload["state"], string> = {
  frozen: "is frozen RIGHT NOW (central's latest probe got no answer)",
  answered: "was frozen, then answered again",
  exited: "was frozen until its process went away (stopped or restarted)",
  paused: "was frozen, then its process was stopped (SIGSTOP / a debugger)",
};

function renderDescription(row: ReportRow, d: BackendFrozenPayload): string {
  return [
    `The backend for worktree \`${d.worktree}\` (pid ${d.pid}) ${STATE_WORDS[d.state]}. ` +
      `Central's liveness probe got no HTTP answer at all from it — not even an ` +
      `error — for **${humanMs(d.unansweredMs)}** of awake time (machine sleep ` +
      `excluded), from ${new Date(d.sinceMs).toISOString()}. Any answer is ` +
      `written by the backend's JS thread, so the thread did not run: a ` +
      `synchronous call blocked it (a sync fs call behind a macOS permission ` +
      `prompt froze main for 5.5 h on 2026-10-11), or an endless loop.`,
    "",
    `In-process monitors (event-loop stall, stuck spans) freeze with the thread, ` +
      `so this report — from central, outside the process — is the live signal. ` +
      `Threshold: ${humanMs(FROZEN_AFTER_MS)} unanswered.`,
    "",
    `**What to do:** if it is still frozen, \`sample ${d.pid} 5\` (macOS) names ` +
      `the native frame the thread is stuck in — a pending permission dialog ` +
      `waiting for an answer shows up as a blocked syscall. Once it runs again, ` +
      `look for an event-loop-stall report and the slow-op spans that closed ` +
      `when it resumed; logs: \`${logsDirFor(d.worktree)}\`.`,
    "",
    `**State:** ${d.state}`,
    `**Unanswered since:** ${new Date(d.sinceMs).toISOString()}`,
    `**Last probe:** ${new Date(d.observedMs).toISOString()}`,
    `**Sightings:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ].join("\n");
}
