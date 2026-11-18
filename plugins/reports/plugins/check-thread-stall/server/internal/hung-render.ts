import type { ReportRow } from "@plugins/reports/server";
import {
  HANG_HELD_MS,
  checkPassHungMessage,
  formatSeconds,
  type CheckPassHungPayload,
} from "../../core";

// The hung-pass task body, apart from the `ReportKind` wiring for the same
// reason as `render.ts`: testable without the reports server barrel.

const CHECKS_DOC =
  "plugins/framework/plugins/tooling/plugins/checks/CLAUDE.md, section " +
  '"A pass that hangs is killed by its own watchdog thread"';

function list(ids: readonly string[]): string {
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(", ") : "none";
}

export function renderCheckPassHungTask(
  row: ReportRow,
  d: CheckPassHungPayload,
): { title: string; description: string } {
  const lines: string[] = [];
  lines.push(
    `A \`./equin check\` pass in \`${d.worktree}\` (pid ${d.pid}) stopped making ` +
      `progress: its one JS thread held its core for **${formatSeconds(d.heldMs)}** ` +
      `of its own CPU time (over ${formatSeconds(d.silentMs)} of wall time) without ` +
      "running a single timer. A healthy pass yields within seconds; this one " +
      `would never have finished. Past ${formatSeconds(HANG_HELD_MS)} held, the ` +
      "pass's watchdog thread captured the evidence below and killed it — so the " +
      "build or push that ran it failed instead of waiting forever.",
  );
  lines.push("");
  lines.push("**What to do:**");
  lines.push(
    "1. Read the main thread's native stack below. Frames only inside the `bun` " +
      "binary under JIT code (`???`) are the runtime itself looping (the " +
      "2026-11-18 hang: a hash-map probe that never found an empty slot) — a " +
      "Bun bug: reproduce if you can, record it, and check whether a newer Bun fixes it. " +
      "A stack in a native addon or a syscall names its own culprit.",
  );
  lines.push(
    "2. A loop in a check's own JS shows as JIT frames too: the checks in flight " +
      "below are the suspects — run each alone (`./equin check <id>`).",
  );
  lines.push(
    "3. " +
      (d.transcript !== null
        ? `The run's transcript is \`${d.transcript}\`; `
        : "") +
      "the host-global check progress log (`check-progress.jsonl`, in the " +
      "`check-progress` logs data dir) has every `start`/`end` and the `hung` " +
      "record under the run id below.",
  );
  lines.push(`4. How the watchdog judges: ${CHECKS_DOC}.`);
  lines.push("");
  lines.push(
    d.bootstrap.length > 0
      ? `**Bootstrap phases in flight:** ${list(d.bootstrap)}`
      : `**Checks in flight (${d.running.length}):** ${list(d.running)}`,
  );
  lines.push(
    `**Last check started:** ${d.lastStarted !== null ? `\`${d.lastStarted}\`` : "none"}`,
  );
  lines.push(
    `**Settled:** ${d.settled}` +
      (d.selected !== null
        ? ` of ${d.selected} selected`
        : " (before selection)"),
  );
  lines.push(`**Run time at the verdict:** ${formatSeconds(d.elapsedMs)}`);
  lines.push("");
  if (d.nativeStack.captured) {
    lines.push(
      `**Main thread, native stack** (full capture: \`${d.nativeStack.file}\`):`,
    );
    lines.push("```");
    lines.push(...d.nativeStack.mainThread);
    lines.push("```");
  } else {
    lines.push(`**Native stack:** not captured — ${d.nativeStack.reason}`);
  }
  lines.push("");
  lines.push(`**Run:** \`${d.runId}\``);
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return {
    title: `[check-hung] ${checkPassHungMessage(d)}`,
    description: lines.join("\n"),
  };
}
