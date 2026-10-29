import { useMemo } from "react";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { resetTrackView, upsertTrackView } from "../shared/endpoints";

// Predicted writes: the song's `trackViews` value shows each change at once
// (the observer, and so every display and the audio scheduler, reads that
// folded value), and the server's rows confirm it. A rejection is toasted by
// the transport.
//
// Order is load-bearing and the transport owns it: these are last-writer-wins
// upserts of the same rows (a fader drag issues ten writes in a second), so
// every write departs on the song's send lane — the `trackViews` `{ songId }`
// tuple, which `patchValue` enters automatically and the reset shares — strictly
// in the order issued. Writes for different songs are different tuples and need
// no order between them.

export interface TrackViewWrites {
  setColor(songId: string, trackId: string, color: string | null): void;
  setInstrument(
    songId: string,
    trackId: string,
    instrumentId: string | null,
  ): void;
  setMuted(songId: string, trackId: string, muted: boolean): void;
  setHidden(songId: string, trackId: string, hidden: boolean): void;
  /**
   * The track's fader position — a linear gain multiplier (1 = unity,
   * 0 = silent, 2 = +6 dB). A drag fires far more changes than there should be
   * writes, so callers are expected to throttle.
   */
  setVolume(songId: string, trackId: string, volume: number): void;
  /**
   * Activate or deactivate a whole set of tracks at once — "active" being the
   * pair the mixer's two toggles govern together: visible in the displays AND
   * audible in the scheduler. One patch, one transaction, one live-state push.
   * The sanctioned cross-plugin way to flip an arrangement (chord mode turns
   * the original tracks off on entry and back on on exit). It returns nothing:
   * the predicted value shows the flip at once, so a caller sequencing layers
   * of sound issues this first, then its own change.
   */
  setActive(songId: string, trackIds: readonly string[], active: boolean): void;
  /** Back to defaults: delete the song's every override. */
  reset(songId: string): void;
}

export function useTrackViewWrites(): TrackViewWrites {
  const { mutate: upsert } = useLiveMutation(upsertTrackView);
  const { mutate: reset } = useLiveMutation(resetTrackView);
  return useMemo(
    () => ({
      setColor: (songId, trackId, color) =>
        upsert({ params: { songId }, body: { trackIds: [trackId], color } }),
      setInstrument: (songId, trackId, instrument) =>
        upsert({
          params: { songId },
          body: { trackIds: [trackId], instrument },
        }),
      setMuted: (songId, trackId, muted) =>
        upsert({ params: { songId }, body: { trackIds: [trackId], muted } }),
      setHidden: (songId, trackId, hidden) =>
        upsert({ params: { songId }, body: { trackIds: [trackId], hidden } }),
      setVolume: (songId, trackId, volume) =>
        upsert({ params: { songId }, body: { trackIds: [trackId], volume } }),
      setActive: (songId, trackIds, active) =>
        upsert({
          params: { songId },
          body: { trackIds: [...trackIds], hidden: !active, muted: !active },
        }),
      reset: (songId) => reset({ params: { songId } }),
    }),
    [upsert, reset],
  );
}
