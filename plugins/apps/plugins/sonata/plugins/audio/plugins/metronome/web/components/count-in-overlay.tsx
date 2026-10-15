import { useEffect, useState } from "react";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useAudioGraph } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import "./count-in-overlay.css";

/**
 * The count-in countdown — a `Sonata.Hud` that paints a large centered number
 * while a lead-in is in progress (`countIn != null`), then disappears. The Hud
 * contributions mount in a small top-right cluster, so to center over the surface
 * this self-portals through `ViewportOverlay` (pointer-events-none, above the
 * display) and centers with `Center`.
 *
 * The remaining count is derived from the audio clock (the same clock the clicks
 * play against, at the instant being heard): `remaining = ceil(beats − elapsed /
 * secPerQuarter)`. A `rAF`
 * loop drives the render cadence (allowed — it's render cadence, not change
 * detection; the transport itself uses rAF for the cursor) and only commits a new
 * value when the integer flips, so the number changes once per click. Re-keying
 * the numeral on `remaining` replays the per-beat pop animation.
 */
export function CountInOverlay() {
  const { countIn, heardNow } = useSession();
  const graph = useAudioGraph();
  const ctx = graph?.ctx ?? null;

  // A bare frame counter purely to drive re-renders while the lead-in runs; the
  // remaining count is DERIVED in render from the live audio clock below (so the
  // first paint is already correct — no flash and no setState in the effect body).
  const [, setFrame] = useState(0);
  useEffect(() => {
    if (!countIn || !ctx) return;
    let raf = 0;
    const tick = () => {
      setFrame((f) => (f + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [countIn, ctx]);

  if (!countIn || !ctx) return null;

  // Clicks remaining = ceil(total beats − elapsed beats), floored at 1. Same
  // clock the clicks are scheduled against, read at the instant being HEARD
  // (one output latency behind), so the number flips with the click's sound.
  const secPerQuarter = countIn.durationSec / countIn.beats;
  const elapsed = heardNow() - countIn.startedAtClockSec;
  const remaining = Math.max(
    1,
    Math.ceil(countIn.beats - elapsed / secPerQuarter),
  );

  return (
    <ViewportOverlay className="pointer-events-none">
      <Center className="size-full">
        <div className="count-in-badge">
          <span key={remaining} className="count-in-number">
            {remaining}
          </span>
        </div>
      </Center>
    </ViewportOverlay>
  );
}
