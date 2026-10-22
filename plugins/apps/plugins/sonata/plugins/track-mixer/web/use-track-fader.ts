import { useEffect, useRef, useState } from "react";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { setTrackVolume } from "./actions";

/**
 * How often a drag is allowed to reach the server, in milliseconds.
 *
 * ~10 writes a second is enough that the audio engine's gain ramp reads as one
 * continuous move rather than a staircase, and few enough that a five-second
 * drag costs fifty rows written and fifty live-state broadcasts instead of the
 * three hundred a per-frame write would cost.
 */
const WRITE_INTERVAL_MS = 100;

/** What a fader hands back to the row that renders it. */
export interface TrackFader {
  /**
   * The level to render — the local draft while the user is moving the fader,
   * the persisted level otherwise. Never the stale one in between.
   */
  value: number;
  /** Every change event from the slider, including the per-frame ones. */
  onValueChange: (next: number) => void;
}

/**
 * The write policy behind one track's fader.
 *
 * Three separate problems, which is why this is a hook and not three lines in
 * the row:
 *
 * **1. The thumb must follow the pointer.** A slider bound straight to the
 * persisted level lags by a round trip on every frame, which feels like the
 * fader is stuck in treacle. So the position on screen comes from local draft
 * state, and the server is told about it separately.
 *
 * **2. The write is throttled leading + trailing, never debounced.** A drag
 * fires a change event per frame. A trailing-only debounce — the reflex fix —
 * never fires at all during a continuous drag, because there is always another
 * event before the timer expires; the user would hear nothing until they
 * stopped moving. A throttle writes immediately on the first change and then at
 * most once per interval, so the audio moves *with* the fader, and its trailing
 * edge guarantees the value the user let go on is the one that lands.
 *
 * **3. The draft is held until the resource echoes it back.** The live-state
 * row is still the pre-drag value for as long as the write is in flight, so
 * dropping the draft at pointer-up would snap the fader back to where it
 * started and then jump forward again when the push arrived. The draft is
 * therefore held until the server reports the value we last sent. If the write
 * fails it never does, and the user's position simply stays on screen — the
 * repo's never-revert policy for local edits: losing a fader move because a
 * request 502'd is worse than showing a level the DB does not yet agree with.
 *
 * A value that arrives having been set by something *else* — the per-song reset
 * button, another surface — is adopted immediately instead, so an outside
 * change is never masked by a draft that is waiting for an echo it will not get.
 *
 * (`primitives/editable-field` is this same shape for text: debounced autosave
 * plus echo reconciliation. It does not fit here — it is `T extends string` and
 * carries caret mapping, neither of which means anything for a number — and
 * generalizing it is a separate piece of work, not this one.)
 */
export function useTrackFader(
  songId: string,
  trackId: string,
  persisted: number,
): TrackFader {
  /** The user's position, or null when there is nothing local to show. */
  const [draft, setDraft] = useState<number | null>(null);
  const fetchEndpoint = useFetchEndpoint();

  // Everything the throttle remembers is a ref. A drag writes at input
  // frequency, and re-rendering the panel just to record "when did I last
  // write" would cost more than the write it exists to avoid.

  /**
   * The most recent value the user has asked for, written or not — null when
   * they have asked for nothing since this fader last converged. That null is
   * what stops a bare click on the thumb (a pointer-up with no move) from
   * writing a row, which would light up the per-song reset button for a track
   * nobody has actually changed.
   */
  const pendingRef = useRef<number | null>(null);
  /** The last value handed to the server; null before the first write. */
  const sentRef = useRef<number | null>(null);
  /**
   * Every value this fader has sent since the last time it converged — how it
   * tells its own echoes from someone else's change. It is bounded by one
   * drag's worth of throttled writes and cleared on convergence.
   */
  const sentValuesRef = useRef<Set<number>>(new Set());
  const lastWriteAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The last persisted value we have seen, to notice when it moves. */
  const seenRef = useRef(persisted);

  const write = useEventCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const value = pendingRef.current;
    if (value === null) return;
    lastWriteAtRef.current = performance.now();
    sentRef.current = value;
    sentValuesRef.current.add(value);
    setTrackVolume(fetchEndpoint, songId, trackId, value);
  });

  const onValueChange = useEventCallback((next: number) => {
    setDraft(next);
    pendingRef.current = next;
    // A trailing write is already booked: it will pick up `pendingRef` when it
    // fires, so there is nothing to schedule and nothing to send early.
    if (timerRef.current !== undefined) return;
    const since = performance.now() - lastWriteAtRef.current;
    if (since >= WRITE_INTERVAL_MS) write();
    else timerRef.current = setTimeout(write, WRITE_INTERVAL_MS - since);
  });

  // There is deliberately no "flush on release". An unsent value always has a
  // trailing write booked (the throttle above either sent it or scheduled it),
  // so a release flush could only ever do one thing: send EARLY, skipping the
  // interval. For a keyboard that is every key-up, which turned ten arrow
  // presses into ten writes. Now that writes are ordered on the resource's send
  // lane (see `actions.ts`), each extra write is also one more queued behind the
  // last — and a queue that lives in page memory is exactly what a reload drops.
  // The trailing edge lands the final value within `WRITE_INTERVAL_MS`; that is
  // the whole cost of not flushing.

  // Flush on unmount rather than dropping the booked write: the row goes away
  // when the song closes or the panel collapses out of the tree, and a fader
  // move made a few milliseconds before that is still a move the user made.
  useEffect(
    () => () => {
      if (pendingRef.current !== sentRef.current) write();
      clearTimeout(timerRef.current);
    },
    [write],
  );

  useEffect(() => {
    if (persisted === seenRef.current) return;
    seenRef.current = persisted;

    // Exact equality is safe here and not a float-comparison sin: the value
    // travels as the same IEEE double all the way out (JSON) and back (a
    // `double precision` column), so a value of ours returns bit-identical.
    if (!sentValuesRef.current.has(persisted)) {
      // Somebody else moved this fader — the per-song reset, or another
      // surface. Adopt it: holding our draft would show the user a level
      // nothing is playing at, and no echo is ever coming to release it.
      sentValuesRef.current.clear();
      sentRef.current = null;
      pendingRef.current = null;
      setDraft(null);
      return;
    }

    // One of ours came back. Only let go of the draft once it is the LATEST one
    // and nothing newer is still queued — an earlier write echoing mid-drag
    // must not yank the thumb back to where it was two frames ago.
    if (
      persisted === sentRef.current &&
      pendingRef.current === sentRef.current
    ) {
      sentValuesRef.current.clear();
      sentRef.current = null;
      pendingRef.current = null;
      setDraft(null);
    }
  }, [persisted]);

  return { value: draft ?? persisted, onValueChange };
}
