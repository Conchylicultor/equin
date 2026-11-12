import type { z } from "zod";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { listWorktreeDirsAsync } from "@plugins/infra/plugins/paths/server";
import { readChannelJson } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import {
  OwnerSampleSchema,
  type OwnerSample,
} from "@plugins/debug/plugins/sentinel/plugins/machine-usage/core";
import {
  TAB_MEMORY_WINDOW_MS,
  TabMemorySampleSchema,
  type TabMemoryData,
  type TabMemorySample,
} from "../../core";
import { pagesFrom, renderersFrom } from "./reduce";
import { TAB_MEMORY_CHANNEL } from "./sink";

/**
 * Lines read per worktree's tab-memory log: ~12 h of 25 pages at one per 5 min.
 * Past that (or past a rotation — only the current file is read) the oldest
 * hours of the window are what drops, never the latest.
 */
const MAX_TAB_LINES = 4_000;
/** health-owners lines read: 12 h at one per 30 s, and some slack. */
const MAX_OWNER_LINES = 1_600;

async function readSince<T>(
  worktree: string,
  channel: string,
  tail: number,
  schema: z.ZodType<T>,
  cutoff: number,
  at: (v: T) => number,
): Promise<T[]> {
  const values = await readChannelJson(worktree, channel, tail, schema);
  return values.filter((v) => at(v) >= cutoff);
}

/** Every worktree's page samples since `cutoff`, per worktree. */
// Async throughout: a live-value loader must never block the event loop.
// Worktrees are read one after another, so the scan yields between files.
export async function readPageLogs(
  cutoff: number,
): Promise<{ worktree: string; samples: TabMemorySample[] }[]> {
  const logs: { worktree: string; samples: TabMemorySample[] }[] = [];
  for (const worktree of await listWorktreeDirsAsync()) {
    const samples = await readSince(
      worktree,
      TAB_MEMORY_CHANNEL,
      MAX_TAB_LINES,
      TabMemorySampleSchema,
      cutoff,
      (s) => s.sampledAt,
    );
    if (samples.length) logs.push({ worktree, samples });
  }
  return logs;
}

/** Main's owner samples (the machine's largest processes, by pid) since `cutoff`. */
export function readOwnerSamples(cutoff: number): Promise<OwnerSample[]> {
  return readSince<OwnerSample>(
    MAIN_WORKTREE_NAME,
    "health-owners",
    MAX_OWNER_LINES,
    OwnerSampleSchema,
    cutoff,
    (s) => s.sampledAt,
  );
}

export async function readTabMemory(): Promise<TabMemoryData> {
  const readAtMs = Date.now();
  const cutoff = readAtMs - TAB_MEMORY_WINDOW_MS;
  const logs = await readPageLogs(cutoff);
  const owners = await readOwnerSamples(cutoff);
  return {
    windowMs: TAB_MEMORY_WINDOW_MS,
    readAtMs,
    pages: pagesFrom(logs),
    renderers: renderersFrom(owners),
  };
}
