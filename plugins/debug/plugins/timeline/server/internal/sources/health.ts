import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { cpus } from "node:os";
import {
  HealthSampleSchema,
  HostSampleSchema,
  type HealthSample,
  type HostSample,
} from "@plugins/debug/plugins/health-monitor/server";
import { readChannelJson } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import type { TimelineHealthPoint } from "../../../shared/frames";
import { backendHealthPoints, hostHealthPoints } from "./health-map";

// Lines read per file, newest kept. The sampler writes every 10s, so a 24h
// window is ~8640 lines; this covers it with headroom. (health-monitor's own
// reader caps at 1500 because its pane defaults to a 2h window — the timeline
// offers up to 24h presets, hence its own cap.) No cutoff filter here: the
// heat-strip downsamplers window the samples themselves.

const MAX_LINES = 12_000;

// One backend lane's downsampled heat-strip series (may be empty — a worktree
// dir without health history is a legitimately-empty lane, not a failure).
export function readHealthLane(
  worktree: string,
  fromMs: number,
  toMs: number,
): TimelineHealthPoint[] {
  const samples = readChannelJson<HealthSample>(
    worktree,
    "health",
    MAX_LINES,
    HealthSampleSchema,
  );
  return backendHealthPoints(samples, fromMs, toMs);
}

// The host lane (load + swap + compressor), sampled only by the main backend.
// The server runs on the host itself (single-instance-per-user), so its cpu
// count is the honest load-ratio denominator for the downsample's pressure
// score — the same value the browser reads via navigator.hardwareConcurrency.
export function readHostLane(
  fromMs: number,
  toMs: number,
): TimelineHealthPoint[] {
  const samples = readChannelJson<HostSample>(
    MAIN_WORKTREE_NAME,
    "health-host",
    MAX_LINES,
    HostSampleSchema,
  );
  return hostHealthPoints(samples, fromMs, toMs, undefined, cpus().length || 8);
}
