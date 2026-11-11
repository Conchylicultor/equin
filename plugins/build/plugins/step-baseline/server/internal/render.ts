import type { ReportRow } from "@plugins/reports/server";
import { stepRegressionLine, type StepRegressionPayload } from "../../core";

// The task body, kept apart from the `ReportKind` wiring (kind.ts) so it is
// testable without evaluating the reports plugin's server barrel.

export function renderStepRegressionTask(
  row: ReportRow,
  d: StepRegressionPayload,
): { title: string; description: string } {
  const lines: string[] = [
    `Main's build \`${d.buildId}\` ran step \`${d.step}\` far past its own ` +
      `recent baseline, and so did the main build before it — the same work ` +
      `(both rebuilt no web artifact), so this is not a one-off cache miss.`,
    "",
    stepRegressionLine(d),
    "",
  ];
  if (d.metric === "fs-calls" && d.calls !== null) {
    const c = d.calls;
    lines.push(
      `**File calls by kind:** ${c.stat} stat, ${c.readdir} readdir, ${c.read} read, ${c.glob} glob.`,
    );
    if (d.increases.length > 0) {
      lines.push(
        "",
        "**Where the extra calls went** (path prefix: now vs baseline median):",
      );
      for (const p of d.increases)
        lines.push(`- \`${p.prefix}\`: ${p.calls} vs ${p.baselineCalls}`);
    }
    lines.push("");
  }
  lines.push(
    "**What to do:** split the step's cost and find why it grew (the " +
      "`perfs-investigation` instructions page). Compare this build's profile " +
      `(Debug → Builds → \`${d.buildId}\` → Profiling) with an earlier main build's. ` +
      "A slowdown in every step at once is the host " +
      "(Disk I/O row, `host-io-degraded` reports); one step alone is its code.",
    "",
    `**Occurrences:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  );
  return {
    title: `[build-step] ${stepRegressionLine(d)}`,
    description: lines.join("\n"),
  };
}
