import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import {
  pedalSpans,
  scoreEndBeat,
  type PedalEvent,
  type Projection,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { usePerformedScore } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/swing/web";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";

/**
 * Merge the per-track pedal lane into unified [downBeat, upBeat] intervals in
 * beats — one visual pedal even when a two-hand piece pedals both hands with
 * identical CC64 lanes. A trailing press with no lift runs to the score end.
 */
function mergedDownIntervals(
  pedalEvents: readonly PedalEvent[],
  end: number,
): [number, number][] {
  const raw = pedalSpans(pedalEvents)
    .map((s): [number, number] => [s.downBeat, s.upBeat ?? end])
    .filter(([d, u]) => u > d)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [d, u] of raw) {
    const last = merged[merged.length - 1];
    if (last && d <= last[1]) last[1] = Math.max(last[1], u);
    else merged.push([d, u]);
  }
  return merged;
}

/**
 * The sustain-pedal lane on the piano roll's falling-note timeline: a thin rail
 * pinned to the lane's left edge, filled over each pedal-DOWN span. Contributed
 * through the generic `Sonata.TransportOverlay` slot, so it lives inside the
 * display's scroll layer and scrolls glued to the notes (a span reaches the
 * now-line exactly when the pedal is pressed in the music) — no per-frame code.
 *
 * Reads the same first-class `score.pedalEvents` lane the audio engine sustains
 * from ({@link resolvePedalSustain}), so what you see is what you hear. Renders
 * nothing on a display without a time axis, or a song with no pedaling.
 *
 * Beat → Y is CONTENT-space and negative for positive beats (future = higher up,
 * more negative). A span's later `up` beat is more negative than its `down`, so
 * the rail's top is `beatToY(up)` and its height is `beatToY(down) - beatToY(up)`
 * — mirroring the loop band's projection idiom.
 */
export function PedalLane({ projection }: { projection: Projection }) {
  const { score } = useSession();
  // Swung like the audio (and the falling notes beside it) unless turned off.
  const performed = usePerformedScore(score);
  const beatToY = projection.beatToY;
  if (!beatToY) return null;

  const intervals = mergedDownIntervals(
    performed.pedalEvents,
    scoreEndBeat(performed),
  );
  if (intervals.length === 0) return null;

  return (
    <>
      {intervals.map(([down, up], i) => {
        const top = beatToY(up);
        const height = Math.max(0, beatToY(down) - beatToY(up));
        return (
          // Pinned to the lane's left edge at the interval's content-space Y;
          // scrolls with the content layer.
          <Placed
            key={i}
            x={{ start: 0, size: 8 }}
            y={{ start: top, size: height }}
            className="rounded-full bg-primary/70 shadow-sm ring-1 ring-primary/30"
          />
        );
      })}
    </>
  );
}
