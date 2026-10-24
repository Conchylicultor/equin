import type { ReportRow } from "@plugins/reports/server";
import {
  checkThreadStallMessage,
  formatSeconds,
  type CheckThreadStallOwner,
  type CheckThreadStallPayload,
} from "../../core";

// The task body, kept apart from the `ReportKind` wiring (index.ts) so it is
// testable without evaluating the reports plugin's server barrel.

/** Where the stall watch — and how to read an owner — is documented. */
const CHECKS_DOC =
  "plugins/framework/plugins/tooling/plugins/checks/CLAUDE.md, section " +
  '"The check thread is shared, and a run reports when it stalls"';

/** The "Check pass speed" wiki track page: the targets, and the measured culprits. */
const TRACK_PAGE = "block-c0e3f7dd-4943-432d-a631-d864fe623fe7";

function ownerLines(owners: readonly CheckThreadStallOwner[]): string[] {
  const lines: string[] = [];
  for (const owner of owners) {
    lines.push(`- \`${owner.owner}\` — ${owner.samples} samples`);
    if (owner.example.length > 0) {
      lines.push("  ```");
      for (const frame of owner.example) lines.push(`  ${frame}`);
      lines.push("  ```");
    }
  }
  return lines.length > 0 ? lines : ["- (no samples were taken)"];
}

function kindsLine(kinds: Record<string, number>): string {
  const entries = Object.entries(kinds).filter(([, count]) => count > 0);
  return entries.length === 0
    ? "no samples"
    : entries
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ");
}

export function renderCheckThreadStallTask(
  row: ReportRow,
  d: CheckThreadStallPayload,
): { title: string; description: string } {
  const lines: string[] = [];
  if (d.trigger === "stall") {
    lines.push(
      `A \`./equin check\` run in \`${d.worktree}\` could not run a timer ` +
        `for **${formatSeconds(d.lateMs)}**: something held the one JS thread every ` +
        "check shares. While it did, no other check ran, every check's duration " +
        "grew by the stall, and a check's own wall-clock timeout could fire " +
        "against a healthy service.",
    );
    lines.push("");
    lines.push(
      `The busiest owner was **\`${d.topOwner}\`**. A \`check <plugin>\` owner is ` +
        "sync work in that check's own `check/` directory. A `shared <fn @ path>` " +
        "owner lost its caller across an `await`: the checks in flight below are " +
        "the ones that could have called it. `import` is module evaluation.",
    );
  } else {
    lines.push(
      `A \`./equin check\` run in \`${d.worktree}\` spent ` +
        `**${formatSeconds(d.stalledMs)}** stalled in total, over ${d.stallCount} ` +
        `stalls (the longest ${formatSeconds(d.longestLateMs)}). The track's target ` +
        "for a whole pass is under 20 s.",
    );
  }
  lines.push("");
  lines.push("**What to do:**");
  lines.push(
    "1. Read the owners and their stacks below. A `blocking-io`-heavy split " +
      "means a sync filesystem or spawn call on the shared thread — move it to " +
      "the async API. A `cpu`-heavy one is real work that should yield or " +
      "move to a Worker.",
  );
  lines.push(
    "2. " +
      (d.transcript !== null
        ? `The run's transcript, \`${d.transcript}\`, has every stall with 5 owners and 8-frame stacks.`
        : "This run wrote no transcript; the host-global check progress log (`check-progress.jsonl`, in the `check-progress` logs data dir) has its `stall` records under the run id below."),
  );
  lines.push(`3. How to read a stall: ${CHECKS_DOC}.`);
  lines.push(
    `4. The measured culprits and the targets: the "Check pass speed" wiki ` +
      `track page (\`read_page\` \`${TRACK_PAGE}\`).`,
  );
  lines.push("");
  if (d.trigger === "stall") {
    lines.push("**Top owners:**");
    lines.push(...ownerLines(d.owners));
    lines.push("");
    lines.push(
      `**What the thread was doing (samples):** ${kindsLine(d.kinds)}`,
    );
    lines.push(
      `**CPU over the stall:** user ${Math.round(d.cpu.userMs)} ms, system ` +
        `${Math.round(d.cpu.systemMs)} ms — near zero against ` +
        `${d.lateMs} ms late means the thread was waiting, not working`,
    );
    lines.push(
      `**Checks in flight:** ${d.running.length > 0 ? d.running.map((c) => `\`${c}\``).join(", ") : "none"}`,
    );
    if (d.bootstrap.length > 0) {
      lines.push(`**Bootstrap phases in flight:** ${d.bootstrap.join(", ")}`);
    }
    lines.push(`**Began:** ${formatSeconds(d.offsetMs)} into the run`);
  } else {
    lines.push("**Who held the thread across all stalls:**");
    lines.push(...ownerLines(d.stallOwners));
    lines.push("");
    lines.push(
      `**What the thread was doing, whole run (samples):** ${kindsLine(d.kinds)}`,
    );
    lines.push(
      `**CPU, whole run:** user ${Math.round(d.cpu.userMs)} ms, system ${Math.round(d.cpu.systemMs)} ms`,
    );
  }
  lines.push("");
  lines.push(`**Run:** \`${d.runId}\``);
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return {
    title: `[check-thread] ${checkThreadStallMessage(d)}`,
    description: lines.join("\n"),
  };
}
