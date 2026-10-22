import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  enqueueDetachedWrite,
  enqueueResourceWrite,
} from "@plugins/primitives/plugins/optimistic-mutation/web";
import { resetTrackView, upsertTrackView } from "../shared/endpoints";
import { trackViews } from "../shared/resources";

// Fire-and-forget writes: the UI never reads the response — state refreshes via
// the `trackViews` push the write's commit triggers. `enqueueDetachedWrite`
// owns the outcome the caller does not read: a server rejection tells the user
// (a toast) and files a report; a network failure still surfaces loudly as an
// unhandled rejection (reported by the crashes plugin).
//
// Fire-and-forget is NOT the same as unordered, and every write here must go
// through the send lane. These are last-writer-wins upserts of the same row, so
// the order the SERVER applies them in is the value the user ends up with. Sent
// as bare concurrent fetches they race: a fader drag issues ten writes in a
// second, a loaded backend finishes them out of order, and an intermediate level
// lands after the final one — the level the user let go on is silently replaced
// by one they dragged through (the track-fader E2E caught exactly this: moved to
// 90%, reloaded to 95%). The same race would let a quick mute-then-unmute land
// backwards, a write queued before a reset resurrect the row it deleted, or chord
// mode's whole-arrangement flip interleave with a toggle the user made at the
// same moment.
//
// `enqueueResourceWrite` puts each write on the song's send lane — the
// `trackViews` `{ songId }` tuple — which departs them strictly in the order
// they were issued. One lane covers every track-view write for that song: that
// serializes writes across its tracks too, which costs a little head-of-line
// latency and buys the guarantee that nothing here can reorder. Writes for
// different songs touch different rows, so they need no order between them.

/** Issue one track-view write on the song's ordered send lane. */
function send(
  songId: string,
  describe: string,
  write: () => Promise<unknown>,
): void {
  enqueueDetachedWrite(
    trackViews,
    { songId },
    { label: "Track", describe },
    write,
  );
}

export function setTrackColor(
  fetchEndpoint: FetchEndpoint,
  songId: string,
  trackId: string,
  color: string | null,
): void {
  send(songId, "color", () =>
    fetchEndpoint(
      upsertTrackView,
      { songId },
      { body: { trackIds: [trackId], color } },
    ),
  );
}

export function setTrackInstrument(
  fetchEndpoint: FetchEndpoint,
  songId: string,
  trackId: string,
  instrumentId: string | null,
): void {
  send(songId, "instrument", () =>
    fetchEndpoint(
      upsertTrackView,
      { songId },
      { body: { trackIds: [trackId], instrument: instrumentId } },
    ),
  );
}

export function setTrackMuted(
  fetchEndpoint: FetchEndpoint,
  songId: string,
  trackId: string,
  muted: boolean,
): void {
  send(songId, "mute", () =>
    fetchEndpoint(
      upsertTrackView,
      { songId },
      { body: { trackIds: [trackId], muted } },
    ),
  );
}

export function setTrackHidden(
  fetchEndpoint: FetchEndpoint,
  songId: string,
  trackId: string,
  hidden: boolean,
): void {
  send(songId, "hide", () =>
    fetchEndpoint(
      upsertTrackView,
      { songId },
      { body: { trackIds: [trackId], hidden } },
    ),
  );
}

/**
 * Write the track's fader position — a linear gain multiplier (1 = unity,
 * 0 = silent, 2 = +6 dB). A drag fires far more changes than there should be
 * writes, so callers are expected to throttle; this stays the plain one-shot
 * write its siblings are.
 */
export function setTrackVolume(
  fetchEndpoint: FetchEndpoint,
  songId: string,
  trackId: string,
  volume: number,
): void {
  send(songId, "volume", () =>
    fetchEndpoint(
      upsertTrackView,
      { songId },
      { body: { trackIds: [trackId], volume } },
    ),
  );
}

/**
 * Activate or deactivate a whole set of tracks at once — "active" being the
 * pair the mixer's two toggles govern together: visible in the displays AND
 * audible in the scheduler. One patch, one transaction, one live-state push.
 * The sanctioned cross-plugin way to flip an arrangement (chord mode turns the
 * original tracks off on entry and back on on exit).
 *
 * Unlike the single-track setters this RETURNS the write's promise: a caller
 * that swaps one layer of sound for another sequences on it (deactivate the
 * originals, THEN bring in the chord tracks), so the listener never hears both
 * layers doubled. Awaiting it is the caller's choice; a dropped promise still
 * surfaces a network failure loudly as an unhandled rejection.
 *
 * It rides the same send lane as the setters above, and `enqueueResourceWrite`
 * hands back the write's own promise — so the caller's sequencing still resolves
 * when THIS write lands, while it can no longer interleave with a toggle the
 * user made at the same moment.
 */
export function setTracksActive(
  fetchEndpoint: FetchEndpoint,
  songId: string,
  trackIds: readonly string[],
  active: boolean,
): Promise<void> {
  return enqueueResourceWrite(trackViews, { songId }, () =>
    fetchEndpoint(
      upsertTrackView,
      { songId },
      { body: { trackIds: [...trackIds], hidden: !active, muted: !active } },
    ),
  );
}

export function resetTrackViews(
  fetchEndpoint: FetchEndpoint,
  songId: string,
): void {
  send(songId, "reset", () => fetchEndpoint(resetTrackView, { songId }));
}
