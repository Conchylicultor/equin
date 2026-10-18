import { z } from "zod";
import {
  getProfilingData,
  type Span,
} from "@plugins/framework/plugins/server-core/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import type { ConfigValues } from "@plugins/config_v2/core";
import { recordReport } from "@plugins/reports/server";
import { bootBudgetConfig } from "../../core";

type Budgets = ConfigValues<(typeof bootBudgetConfig)["fields"]>;

// Per-process set of boot span names ALREADY reported this process. THE dedup
// mechanism: boot happens once per process, so the profile is static after boot
// and the monitor re-reads the SAME over-budget spans every tick. Recording each
// filed span here makes a given (worktree, span-name, boot-epoch) file at most
// once — the process lifetime IS the boot epoch, so this Set is inherently
// per-boot-epoch. Across a restart the module reloads with a fresh Set, so a
// chronically-slow hook re-files, collapsing onto its stable fingerprint row
// (`count` = number of boots it was slow). This is the pull-signal analog of
// op-rate's module-level baseline maps (which gate its re-fire on unchanged
// data); boot-budget has no event stream to drain, it
// pulls a static profile, so the guard is "already reported" rather than a delta.
const reported = new Set<string>();

// Cheap per-worktree scheduled boot-budget monitor. Runs every minute in EACH
// worktree's own backend (perWorktree) because getProfilingData() is per-process
// in-memory boot state — every backend has its OWN boot profile to check.
// `dedup: "singleton"` + `maxAttempts: 3` mirror the other debug monitors.
// Silent when every boot span is within budget. Reads the post-boot profile ONCE
// per tick (pull-only, no recorder hook) and files a deduped report per boot
// hook / warmup span whose wall-time exceeds its per-phase budget.
export const bootBudgetMonitorJob = defineJob({
  name: "debug.boot-budget-monitor",
  description:
    "Files a report for each startup step or warm-up that took longer than its time budget.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "* * * * *", perWorktree: true },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(bootBudgetConfig);
    if (!cfg.enabled) return;

    const { spans, memoryCheckpoints } = getProfilingData();
    // The authoritative phase-boundary RSS snapshots (per-span deltas overlap in
    // the parallel onReady phases and are only directional). Carried into the
    // report so the reader can tell heavy CPU work (RSS spikes) from IO wait
    // (flat RSS) — trimmed to the compact fields the renderer shows.
    const checkpoints = memoryCheckpoints.map((c) => ({
      label: c.label,
      atMs: c.atMs,
      physFootprintMb: c.physFootprintMb,
      heapUsedMb: c.heapUsedMb,
    }));

    for (const span of spans) {
      const budgetMs = budgetForSpan(span, cfg);
      if (budgetMs === null) continue; // not a monitored boot span
      if (span.durationMs <= budgetMs) continue; // within budget
      if (reported.has(span.id)) continue; // already filed this boot
      reported.add(span.id);
      await recordReport({
        kind: "boot-budget",
        source: "server-boot-budget-monitor",
        data: {
          spanName: span.id,
          phase: span.phase,
          ...(span.plugin ? { plugin: span.plugin } : {}),
          durationMs: span.durationMs,
          budgetMs,
          memoryCheckpoints: checkpoints,
        },
        message: `${span.id} — ${span.durationMs}ms boot (${span.phase}, budget ${budgetMs}ms)`,
      });
    }
  },
});

// Map a profiler span to its wall-time budget, or null when the span is not a
// monitored boot hook / warmup. Warmups (`warmup:<name>`) are checked FIRST — a
// warmup span may carry any phase (they drain after onAllReady), so its id
// prefix, not its phase, decides its budget. Per-plugin boot-hook spans require
// `span.plugin` set, which cleanly excludes the whole-phase wrapper spans
// (`onReadyBlocking` etc., recorded with no plugin) so we attribute to a specific
// plugin, never the aggregate phase.
function budgetForSpan(span: Span, cfg: Budgets): number | null {
  if (span.id.startsWith("warmup:")) return cfg.warmupBudgetMs;
  if (span.plugin == null) return null;
  // An if-chain, not a switch: PhaseId is a growing closed union and we budget
  // only three of its members — switch-exhaustiveness-check would force a case
  // per member (register/migrations/…) that all return null.
  if (span.phase === "onReadyBlocking") return cfg.onReadyBlockingBudgetMs;
  if (span.phase === "onReady") return cfg.onReadyBudgetMs;
  if (span.phase === "onAllReady") return cfg.onAllReadyBudgetMs;
  return null;
}
