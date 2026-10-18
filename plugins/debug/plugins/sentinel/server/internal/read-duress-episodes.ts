import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { readChannelJson } from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import {
  DURESS_EPISODES_CHANNEL,
  DuressEpisodeEventSchema,
  type DuressEpisodeEvent,
} from "../../core";

// Lines read from the channel tail (newest kept). Episodes are rare (a
// handful per bad day at two lines each), so this comfortably covers any
// realistic lookback window. Mirrors boot-events' readBootEvents.
const MAX_LINES = 1000;

/**
 * The duress-episode transitions whose instant falls inside the window,
 * read from main's `duress-episodes` channel (the sentinel worker — the
 * latch's sole writer — is main-only, so main's log dir is the one source).
 *
 * Deliberately returns raw transition events, not paired intervals: every
 * line carries `episodeSetAt`, so a clear line alone fully determines its
 * interval ([episodeSetAt, atMs]) even when its trip predates the window,
 * and an unpaired trip (open episode) renders open-ended. Stale unpaired
 * trips (a crash with no clear line — the accepted lapse gap) age out of the
 * window naturally instead of banding every future timeline.
 */
export function readDuressEpisodes(windowMs: number): DuressEpisodeEvent[] {
  const cutoff = Date.now() - windowMs;
  // Envelope-unwrap + safeParse-drop via the log-channels primitive (a missing
  // duress-episodes.jsonl — no episode since the channel shipped — is a
  // legitimately-empty history), then keep transitions inside the window.
  return readChannelJson(
    MAIN_WORKTREE_NAME,
    DURESS_EPISODES_CHANNEL,
    MAX_LINES,
    DuressEpisodeEventSchema,
  ).filter((e) => e.atMs >= cutoff);
}
