import { z } from "zod";
import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";

// Re-alert the bell at most once per ~4h while a target keeps failing to reap.
// A reap failure is a persistent condition — the hourly sweep retries the same
// target every tick — so the cooldown re-surfaces it periodically without
// filing a fresh alert every hour, matching the render-loop re-arm shape.
const REAP_FAILED_NOTIF_COOLDOWN_MS = 4 * 60 * 60 * 1000;

// The jsonb payload for a `worktree-reap-failed` report. `timedOut` is the whole
// point of the payload: it comes from `err instanceof WorktreeGitTimeoutError`,
// so a killed git child is classified at the throw site rather than guessed from
// the message here. `command` / `timeoutMs` are present only on that arm.
//
// Declared here rather than in a `core/` barrel (where a kind with a web
// renderer keeps its twin) because this kind has no web renderer: the payload has exactly one
// reader, the renderTask below, and nothing in the browser needs its type.
const ReapFailedPayloadSchema = z.object({
  targetId: z.string(),
  timedOut: z.boolean(),
  command: z.string().optional(),
  timeoutMs: z.number().optional(),
  message: z.string(),
});
type ReapFailedPayload = z.infer<typeof ReapFailedPayloadSchema>;

// The `worktree-reap-failed` report kind. The hourly reaper contains per-target
// failures so one corrupt fork cannot block the sweep — this kind is what keeps
// that containment from also being silence. Dedups per (target, timeout-or-not),
// so a target failing every tick collapses onto one counting row, and a wedged
// git child is never merged with an ordinary failure on the same target: they
// have different causes and different fixes.
export const worktreeReapFailedKind = ReportKind({
  kind: "worktree-reap-failed",
  schema: ReapFailedPayloadSchema,
  fingerprint: (d: ReapFailedPayload) =>
    `worktree-reap-failed:${d.targetId}:${d.timedOut ? "timeout" : "error"}`,
  meta: {
    tag: "[reap]",
    notif: "Worktree reap failed",
    variant: "error",
    notifCooldownMs: REAP_FAILED_NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = ReapFailedPayloadSchema.parse(row.data);
    return {
      title: d.timedOut
        ? `[reap] Git command killed on a bound while reaping ${d.targetId}`
        : `[reap] Reap failed: ${d.targetId}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: ReapFailedPayload): string {
  const lines: string[] = [];
  if (d.timedOut) {
    lines.push(
      `While reaping the stale worktree \`${d.targetId}\`, a git command did not ` +
        `finish within its bound of ${d.timeoutMs ?? "?"} ms and **was killed**.`,
    );
    lines.push("");
    lines.push(
      `**This is the signal the bounds exist to produce.** These git commands run ` +
        `while holding one of the few host-wide \`worktree-mutate\` flock slots, so a ` +
        `child that hangs there does not stall one caller — it blocks worktree ` +
        `checkouts on **every backend on the machine**. That is exactly the ` +
        `2026-08-17 outage, where an unbounded \`git worktree remove\` held the flock ` +
        `until a human noticed. The bound converted the hang into a kill: the slot ` +
        `was released and the machine kept working, and this report is the record ` +
        `that a wedge happened at all.`,
    );
    lines.push("");
    lines.push(
      `**What to do:** a bound only fires on a genuinely wedged child (the values ` +
        `are ~100× the measured p50 — see ` +
        `\`research/2026-08-17-global-reap-stale-cost-and-bounded-execution.md\`), so ` +
        `treat this as a real wedge, not a slow box. Find out what the git command ` +
        `was blocked on — a lock in the repo, a stuck NFS/disk read, a surviving ` +
        `grandchild process — rather than raising the bound. If the **Occurrences** ` +
        `count keeps growing, the same target wedges on every hourly tick and the ` +
        `worktree will never be reclaimed until it is fixed by hand.`,
    );
  } else {
    lines.push(
      `The hourly stale-worktree sweep (\`worktree-cleanup.reap-stale\`) failed to ` +
        `reap \`${d.targetId}\`. The git command completed — this is an ordinary ` +
        `failure, not a killed child.`,
    );
    lines.push("");
    lines.push(
      `The failure is **contained on purpose**: one unreapable target must not block ` +
        `the rest of the sweep, and the sweep is idempotent, so the next hourly tick ` +
        `retries this target. Nothing is stuck as a result — but the disk, the fork ` +
        `database and the gateway registration for this worktree stay allocated until ` +
        `the reap succeeds.`,
    );
    lines.push("");
    lines.push(
      `**What to do:** read the error below. A one-off (**Occurrences** 1) usually ` +
        `resolved itself on the next tick and can be dismissed. A growing count means ` +
        `every retry hits the same failure — the target needs removing by hand, or the ` +
        `reap sequence (\`server/internal/reap.ts\`) is missing a case.`,
    );
  }
  lines.push("");
  lines.push(`**Target:** \`${d.targetId}\``);
  if (d.command) lines.push(`**Command:** \`${d.command}\``);
  if (d.timeoutMs != null) lines.push(`**Bound:** ${d.timeoutMs} ms`);
  lines.push("");
  lines.push("**Error:**");
  lines.push("```");
  lines.push(d.message);
  lines.push("```");
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
