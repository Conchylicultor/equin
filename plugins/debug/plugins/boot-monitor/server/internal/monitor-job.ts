import { z } from "zod";
import { getProfilingData } from "@plugins/framework/plugins/server-core/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { recordSlowOp } from "@plugins/debug/plugins/slow-ops/server";
import type { BootSection } from "@plugins/debug/plugins/trace/plugins/boot/core";
import { bootMonitorConfig } from "../../core";
import { getGatewayBootReport } from "./gateway-report";

// Per-process "this boot was already checked" flag. THE dedup mechanism: boot
// happens once per process, so the profile is static once complete and every
// later tick would re-read the same data. The process lifetime IS the boot
// epoch, so this boolean is inherently per-boot-epoch (boot-budget's Set,
// collapsed to one bit — this monitor judges the whole boot, not per span).
// Across a restart the module reloads with a fresh flag, so a chronically-slow
// boot re-mints, collapsing onto its stable slow_ops row (`count` = number of
// slow boots for this worktree).
let minted = false;

// Cheap per-worktree scheduled whole-boot monitor. Runs every minute in EACH
// worktree's own backend (perWorktree) because getProfilingData() is per-process
// in-memory boot state — every backend has its OWN boot to judge.
// `dedup: "singleton"` + `maxAttempts: 3` mirror the other debug monitors.
// Trip-only: a within-budget boot mints nothing (Debug → Boot Profile stays the
// always-on deep-dive); an over-budget boot mints evidence-first — the coherent
// trace before the durable slow-op row, the documented contract in
// record-slow-op.ts — so the row and report can deep-link the trace id.
export const bootMonitorJob = defineJob({
  name: "debug.boot-monitor",
  description:
    "Files a report with a boot trace when a backend's whole startup took longer than its budget.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "* * * * *", perWorktree: true },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(bootMonitorConfig);
    if (!cfg.enabled) return;
    if (minted) return;

    const { spans, totalDurationMs, memoryCheckpoints } = getProfilingData();
    // Boot-completeness guard: profilerStart pushes a span only when its end()
    // closure runs, so the presence of the `settled` span (the framework's
    // final, post-onAllReady settled phase — the warm-up drain) is a
    // deterministic "boot fully complete" signal, whatever plugins the graph
    // holds. Until it appears the profile is still growing — judging
    // totalDurationMs mid-boot would under-report a slow boot as fast — so the
    // tick is skipped, not marked.
    if (!spans.some((s) => s.phase === "settled")) return;
    minted = true;

    if (totalDurationMs <= cfg.totalBootBudgetMs) return;

    // The trip metric is the profiler's own totalDurationMs — deterministic and
    // gateway-version-independent; the gateway-observed wait is section
    // EVIDENCE, never the trip metric.
    const gateway = getGatewayBootReport();
    const section: BootSection = {
      // Epoch ms of process start — the wall anchor for every offset in the
      // section, and boot-events' pairing key.
      wallStartMs: Math.round(performance.timeOrigin),
      totalDurationMs,
      spans: spans.map((s) => ({
        id: s.id,
        phase: s.phase,
        ...(s.plugin !== undefined ? { plugin: s.plugin } : {}),
        label: s.label,
        startMs: s.startMs,
        durationMs: s.durationMs,
        ...(s.physFootprintStartMb !== undefined
          ? { physFootprintStartMb: s.physFootprintStartMb }
          : {}),
        ...(s.physFootprintEndMb !== undefined
          ? { physFootprintEndMb: s.physFootprintEndMb }
          : {}),
      })),
      // The authoritative phase-boundary RSS snapshots, trimmed to the compact
      // fields the lane shows (the boot-budget trim).
      memoryCheckpoints: memoryCheckpoints.map((c) => ({
        label: c.label,
        atMs: c.atMs,
        physFootprintMb: c.physFootprintMb,
        heapUsedMb: c.heapUsedMb,
      })),
      ...(gateway !== null ? { gateway } : {}),
    };

    const trace = captureTrace({
      kind: "boot",
      label: "server-boot",
      durationMs: totalDurationMs,
      thresholdMs: cfg.totalBootBudgetMs,
      detail: section,
    });
    await recordSlowOp({
      operationKind: "boot",
      operation: "server-boot",
      durationMs: totalDurationMs,
      ownMs: totalDurationMs,
      thresholdMs: cfg.totalBootBudgetMs,
      source: "server-boot-monitor",
      caller: null,
      ...(trace ? { traceId: trace.id } : {}),
    });
  },
});
