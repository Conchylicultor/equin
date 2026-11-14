/**
 * A playback timeline running on the page: a player that is playing renders on
 * its clock (a playhead, the keys lighting as notes sound) while the person
 * listens without touching anything. That is the page doing what it was asked
 * to, not a loop — but to the detector's idle gate (no input for IDLE_MS) it
 * looks exactly like one. So a player holds playback while it plays and
 * releases it when it stops; the detector counts a held playback as activity,
 * the way it counts a key press, and judges idleness only from IDLE_MS after
 * the last playback ended.
 *
 * Only the session that owns a timeline's play state may hold it (one hold per
 * playing session); a hold never covers a component's own re-renders outside
 * playback.
 */
let held = 0;

/** Marks a playback timeline as running; call the returned release once it stops (idempotent). */
export function holdPlayback(): () => void {
  held++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held--;
  };
}

/** Whether any playback timeline on the page is running. */
export function playbackHeld(): boolean {
  return held > 0;
}
