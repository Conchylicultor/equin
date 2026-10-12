import type { HookKind, ProfilerReport } from "./types";

/**
 * Human-readable rendering of a `ProfilerReport` — the ranked initiators and
 * remount positions, as a plain multi-line string.
 *
 * This lives in `core/` rather than in a caller because two *different* plugins'
 * e2e scripts print the same report: this plugin's `render-profile.ts` (which
 * profiles a URL directly) and `debug/live-state-churn/emit`'s
 * `live-state-churn.ts` (which profiles under a synthetic push storm). Both
 * previously carried a byte-identical ~50-line copy of the label map and print
 * loop. It is pure formatting over a type this plugin already owns — no
 * Playwright, no DOM — so it is a genuine public API, available to the Debug
 * pane too.
 */

const HOOK_LABEL: Record<HookKind, string> = {
  state: "useState/useReducer",
  reducer: "useReducer",
  "external-store": "useSyncExternalStore",
  effect: "effect",
  "layout-effect": "layout effect",
  memo: "useMemo",
  callback: "useCallback",
  ref: "useRef",
  context: "context",
  unknown: "hook",
};

export interface FormatProfilerReportOptions {
  /** How many ranked rows to show per section. Default 20. */
  top?: number;
  /** Also print every commit: when, how many fibers rendered, under whom. */
  commits?: boolean;
}

export function formatProfilerReport(
  report: ProfilerReport,
  opts: FormatProfilerReportOptions = {},
): string {
  const top = opts.top ?? 20;
  const lines: string[] = [];

  lines.push(
    `total commits: ${report.totalCommits} · ${report.commitsPerSec.toFixed(1)}/s over ${(report.durationMs / 1000).toFixed(1)}s`,
  );

  const initiators = report.initiators.slice(0, top);
  lines.push("");
  if (initiators.length === 0) {
    lines.push("(no initiators recorded — the screen was idle / stable)");
  } else {
    for (const s of initiators) {
      const path = s.ancestorPath.length
        ? `${s.ancestorPath.join(" > ")} > `
        : "";
      const hooks = s.changedHooks
        .map((h) => `${HOOK_LABEL[h.kind] ?? h.kind} #${h.index}`)
        .join(", ");
      const instances = s.instanceCount > 1 ? ` ×${s.instanceCount}` : "";
      const mu = ` (${s.mountCount}m/${s.updateCount}u)`;
      lines.push(
        `${s.commitCount.toString().padStart(5)}  ${s.ratePerSec.toFixed(1).padStart(5)}/s  ${s.fibersRendered.toString().padStart(7)} fibers  ${path}${s.componentName}${instances}${mu}${hooks ? `  [${hooks}]` : ""}`,
      );
    }
  }

  // The same initiators by what they cost: fibers rendered under them.
  const bySize = [...report.initiators]
    .sort((a, b) => b.fibersRendered - a.fibersRendered)
    .slice(0, top);
  if (bySize.length > 0) {
    const total = report.initiators.reduce((n, s) => n + s.fibersRendered, 0);
    lines.push("");
    lines.push(`by fibers rendered (${total} in all):`);
    for (const s of bySize) {
      const hooks = s.changedHooks
        .map((h) => `${HOOK_LABEL[h.kind] ?? h.kind} #${h.index}`)
        .join(", ");
      lines.push(
        `${s.fibersRendered.toString().padStart(7)}  ${s.commitCount.toString().padStart(4)}×  ${s.ancestorPath.slice(-3).join(" > ")} > ${s.componentName}${hooks ? `  [${hooks}]` : ""}`,
      );
    }
  }

  if (opts.commits === true) {
    lines.push("");
    lines.push(
      `commits${report.commitLogTruncated === true ? " (log truncated)" : ""} — ms, fibers rendered, initiators:`,
    );
    for (const c of report.commits) {
      const who = c.initiators
        .slice(0, 4)
        .map((i) => `${i.name} ${i.rendered}`)
        .join(", ");
      const more =
        c.initiators.length > 4 ? ` +${c.initiators.length - 4}` : "";
      lines.push(
        `${c.atMs.toFixed(0).padStart(7)}  ${c.rendered.toString().padStart(6)}  ${who}${more}`,
      );
    }
  }

  const remounts = (report.remounts ?? []).slice(0, top);
  lines.push("");
  lines.push("remounts:");
  if (report.remountTruncated) {
    lines.push("(position map hit its cap — some remounts may be missed)");
  }
  if (remounts.length === 0) {
    lines.push("(no remounts recorded — nothing destroyed-and-rebuilt)");
  } else {
    for (const r of remounts) {
      const path = r.ancestorPath.length
        ? `${r.ancestorPath.join(" > ")} > `
        : "";
      lines.push(
        `${r.count.toString().padStart(5)}  ${path}${r.fromType} > ${r.toType}  [${r.cause}]`,
      );
    }
  }

  return lines.join("\n");
}
