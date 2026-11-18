import { useEffect, useState } from "react";
import { z } from "zod";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import { seekMedia } from "./media-ops";

/**
 * Where a player's playhead stood, in seconds — kept as view state, so a
 * reload (an upgrade into a new build included) or a remount (tab residency
 * unmounts a hidden tab) gives the player back where it was, PAUSED: playback
 * is a process, and sound never starts again on its own. Exact once paused,
 * sought or ended; the second it was in while it played (written once a
 * second, not on every `timeupdate`).
 *
 * One entry per player in a place (the ambient `KeepScope`), told apart by the
 * caller's `keep` key — which names the media, so another file under the same
 * key would be sought to this one's time.
 */
const keptPlayhead = defineKept({
  owner: "media-player.playhead",
  tier: "view",
  schema: z.number().min(0).nullable(),
});

/**
 * The player's kept playhead, bound to its media element: a player that finds
 * one is a **resumed** player — it seeks there once the metadata is in and
 * never autoplays (`autoPlay` means "play when opened", not "play on every
 * reload"); from then on (at once for a fresh one) every move of the playhead
 * is recorded. Whether it resumed is decided at mount, never by its own
 * later writes.
 */
export function useKeptPlayhead(
  el: HTMLMediaElement | null,
  keep: string | null,
): { resumed: boolean } {
  const [at, setAt] = useKept(keptPlayhead, null, { key: keep });
  const [resumeAt] = useState(at);

  useEffect(() => {
    if (el === null) return;
    const listening = new AbortController();
    const signal = listening.signal;
    // While playing, the second it is in: a write per second, not per frame.
    let second = -1;
    const exact = () => {
      second = Math.floor(el.currentTime);
      setAt(el.currentTime);
    };
    const coarse = () => {
      const s = Math.floor(el.currentTime);
      if (s === second) return;
      second = s;
      setAt(s);
    };
    const record = () => {
      for (const type of ["pause", "seeked", "ended"])
        el.addEventListener(type, exact, { signal });
      el.addEventListener("timeupdate", coarse, { signal });
    };
    // Recording waits for the seek back: a `timeupdate` at 0 before it would
    // overwrite the kept time with the start.
    const resume = (time: number) => {
      seekMedia(
        el,
        Number.isFinite(el.duration) ? Math.min(time, el.duration) : time,
      );
      record();
    };
    if (resumeAt === null) record();
    else if (el.readyState >= HTMLMediaElement.HAVE_METADATA) resume(resumeAt);
    else
      el.addEventListener("loadedmetadata", () => resume(resumeAt), {
        once: true,
        signal,
      });
    return () => listening.abort();
  }, [el, resumeAt, setAt]);

  return { resumed: resumeAt !== null };
}
