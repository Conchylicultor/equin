import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { listWorktreeDirsAsync } from "@plugins/infra/plugins/paths/server";
import { readChannelJsonAsync } from "@plugins/primitives/plugins/log-channels/server";
import { readSlowOpMarkers } from "@plugins/debug/plugins/slow-ops/server";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  HealthSampleSchema,
  HostSampleSchema,
  type HealthSample,
  type HealthSeries,
  type HostSample,
} from "../../core";

// Cap on lines read per worktree file (newest kept). At 10s/sample, 1500 lines
// is ~4h of history — comfortably above the default 2h read window.
const MAX_LINES = 1500;

// Read a channel's JSON payloads (envelope-unwrap + safeParse-drop via the
// log-channels primitive) and keep only samples at/after the read cutoff.
async function parseSamples<T>(
  worktree: string,
  channel: string,
  schema: ZodParser<T>,
  cutoff: number,
  sampledAt: (v: T) => number,
): Promise<T[]> {
  const values = await readChannelJsonAsync(
    worktree,
    channel,
    MAX_LINES,
    schema,
  );
  return values.filter((v) => sampledAt(v) >= cutoff);
}

// Every read is async: the reader is a live-value loader, which must never
// block the event loop (it would freeze every other loader and request on the
// very backend whose health the pane measures). Worktrees are read one after
// another, so the scan yields between files rather than opening ~200 at once.
export async function readHealthSeries(windowMs: number): Promise<{
  series: HealthSeries[];
  hostSamples: HostSample[];
}> {
  const cutoff = Date.now() - windowMs;

  const series: HealthSeries[] = [];
  for (const name of await listWorktreeDirsAsync()) {
    const samples = await parseSamples<HealthSample>(
      name,
      "health",
      HealthSampleSchema,
      cutoff,
      (s) => s.sampledAt,
    );
    if (samples.length) {
      const slowOpMarkers = await readSlowOpMarkers(name, windowMs);
      series.push({ worktree: name, samples, slowOpMarkers });
    }
  }

  const hostSamples = await parseSamples<HostSample>(
    MAIN_WORKTREE_NAME,
    "health-host",
    HostSampleSchema,
    cutoff,
    (s) => s.sampledAt,
  );

  return { series, hostSamples };
}
