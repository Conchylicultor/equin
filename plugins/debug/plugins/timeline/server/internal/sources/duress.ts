import { readDuressEpisodes } from "@plugins/debug/plugins/sentinel/server";
import type { TimelineEvent } from "../../../core";
import { mapDuressEpisodes } from "./duress-map";

// Disk-backed duress lane (main's log dir only — the sentinel worker, the
// latch's sole writer, is main-only). readDuressEpisodes takes a lookback
// window relative to now and filters on each line's atMs, so we hand it
// now − fromMs: a clear line inside (or after) the window still carries its
// full interval via episodeSetAt, and stale unpaired trips age out with it.
export async function loadDuressEpisodes(
  fromMs: number,
  toMs: number,
): Promise<TimelineEvent[]> {
  const windowMs = Math.max(0, Date.now() - fromMs);
  return mapDuressEpisodes(await readDuressEpisodes(windowMs), fromMs, toMs);
}
