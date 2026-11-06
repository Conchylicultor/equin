import type { z } from "zod";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { listWorktreeDirsAsync } from "@plugins/infra/plugins/paths/server";
import { readChannelJson } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import { readSlowOpMarkers } from "@plugins/debug/plugins/slow-ops/server";
import {
  OwnerSampleSchema,
  type OwnerSample,
} from "@plugins/debug/plugins/sentinel/plugins/machine-usage/core";
import {
  MAX_HEALTH_SAMPLES,
  HealthSampleSchema,
  HostSampleSchema,
  type HealthSample,
  type HealthSeries,
  type HostSample,
} from "../../core";

// Read a channel's JSON payloads (envelope-unwrap + safeParse-drop via the
// log-channels primitive) and keep only samples at/after the read cutoff.
async function parseSamples<T>(
  worktree: string,
  channel: string,
  schema: z.ZodType<T>,
  cutoff: number,
  sampledAt: (v: T) => number,
): Promise<T[]> {
  const values = await readChannelJson(
    worktree,
    channel,
    MAX_HEALTH_SAMPLES,
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
  ownerSamples: Omit<OwnerSample, "top">[];
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

  const ownerSamples = (
    await parseSamples<OwnerSample>(
      MAIN_WORKTREE_NAME,
      "health-owners",
      OwnerSampleSchema,
      cutoff,
      (s) => s.sampledAt,
    )
  ).map(({ top: _top, ...rest }) => rest);

  return { series, hostSamples, ownerSamples };
}
