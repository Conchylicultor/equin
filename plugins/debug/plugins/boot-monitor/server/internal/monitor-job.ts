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
// collapsed to one bit — this monitor judges the boot's time to ready, not
// per span).
// Across a restart the module reloads with a fresh flag, so a chronically-slow
// boot re-mints, collapsing onto its stable slow_ops row (`count` = number of
// slow boots for this worktree).
let minted = false;

// Cheap per-worktree scheduled time-to-ready monitor. Runs every minute in EACH
// worktree's own backend (perWorktree) because getProfilingData() is per-process
// in-memory boot state — every backend has its OWN boot to judge.
// `dedup: "singleton"` + `maxAttempts: 3` mirror the other debug monitors.
// Trip-only: a boot ready within budget mints nothing (Debug → Boot Profile stays the
// always-on deep-dive); an over-budget boot mints evidence-first — the coherent
// trace before the durable slow-op row, the documented contract in
// record-slow-op.ts — so the row and report can deep-link the trace id.
export const bootMonitorJob = defineJob({
  name: "debug.boot-monitor",
  description:
    "Files a report with a boot trace when a backend took longer than its budget to become ready.",
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

    const { spans, totalDurationMs, memoryCheckpoints, timeToReadyMs } =
      getProfilingData();
    // The trip metric is time to READY — process start → markServerReady(),
    // the barrier the gateway waits on before it switches to this backend —
    // never the profile's end: that waits for the settled phase's warm-up
    // drain, background work each warm-up's own budget already judges
    // (slow-ops). Readiness is final once stamped, so the first tick after
    // it judges; until then the tick is skipped, not marked. The
    // gateway-observed wait stays section EVIDENCE, never the trip metric.
    if (timeToReadyMs === null) return;
    minted = true;

    if (timeToReadyMs <= cfg.readyBudgetMs) return;

    const gateway = getGatewayBootReport();
    const section: BootSection = {
      // Epoch ms of process start — the wall anchor for every offset in the
      // section, and boot-events' pairing key.
      wallStartMs: Math.round(performance.timeOrigin),
      totalDurationMs,
      timeToReadyMs,
      // The spans recorded by the mint tick: the boot through ready, plus
      // whatever post-ready work has finished since (context, not the verdict).
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
      label: "server-ready",
      durationMs: timeToReadyMs,
      thresholdMs: cfg.readyBudgetMs,
      detail: section,
    });
    await recordSlowOp({
      operationKind: "boot",
      operation: "server-ready",
      durationMs: timeToReadyMs,
      ownMs: timeToReadyMs,
      thresholdMs: cfg.readyBudgetMs,
      source: "server-boot-monitor",
      caller: null,
      ...(trace ? { traceId: trace.id } : {}),
    });
  },
});
