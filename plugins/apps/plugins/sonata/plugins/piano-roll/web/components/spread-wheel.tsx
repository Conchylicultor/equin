import { useRef } from "react";
import { useSetConfig } from "@plugins/config_v2/web";
import { usePlayerView } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { useInertialDrag } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/inertial-drag/web";
import { JogWheel } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/jog-wheel/web";
import { pianoRollConfig } from "../../shared/config";
import { SPREAD_MIN } from "./geometry";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const spreadIcon = symbol("height");

/** Log-zoom units per pixel of horizontal drag. The wheel scrubs `log(spread)`,
 *  so each pixel multiplies the zoom by a CONSTANT ratio (exp(SENSITIVITY)) no
 *  matter where you are in the range — the standard log-scale zoom feel. Tuned so
 *  a ~200px sweep is ≈2.7× and the default [0.4, 3] band spans a comfortable
 *  ~400px. A wider range (long-song fit) just makes the sweep proportionally
 *  longer — the per-pixel feel never changes. */
const SENSITIVITY = 0.005;

/** Pixels the ribbed face travels per natural-log unit of zoom — chosen so the
 *  ribs slide a wheel-like distance across the default range. */
const RIB_SCALE = 60;

/** Zoom-style readout: one decimal at/above 1×, two below (so a deep fit-zoom
 *  like 0.05× still reads precisely rather than rounding to 0×). */
const asZoom = (spread: number) =>
  spread >= 1
    ? `${Math.round(spread * 10) / 10}×`
    : `${Math.round(spread * 100) / 100}×`;

/** Quick-set zooms offered by clicking the readout (each clamped by the live
 *  range, so none is offered that the roll cannot show). */
const SPREAD_PRESETS = [0.5, 0.75, 1, 1.5, 2, 3];

/**
 * A horizontal jog wheel for the piano-roll vertical zoom ("spread"). Drag it
 * left/right (with release momentum, via the shared inertial-drag primitive) to
 * scrub the live `spread` the renderer reads — ephemeral transport state, so the
 * drag is a pure 60fps rescale with zero server round-trips. On settle the
 * committed value is written back to the GLOBAL `pianoRollConfig.spread` so it
 * persists across songs and reloads. The ribbed face slides with the value for a
 * physical-wheel feel; the same value is also reachable from the Settings pane
 * (the `spread` float field) and from pinch / Ctrl+scroll over the roll.
 */
export function SpreadWheel() {
  // Spread is the piano roll's own zoom: under any other display it would
  // scale nothing, so the header shows it only while the roll is showing.
  const { displayId } = usePlayerView();
  if (displayId !== "piano-roll") return null;
  return <PianoRollSpreadWheel />;
}

function PianoRollSpreadWheel() {
  const { spread, spreadMin, spreadMax, setSpread } = usePlayerView();
  const setConfig = useSetConfig(pianoRollConfig);
  // The last scrubbed value, captured so the (value-less) settle callback
  // commits exactly where the fling came to rest.
  const lastValue = useRef(spread);

  // Scrub in LOG space: the drag value is `log(spread)`, so a fixed pixel travel
  // is a fixed zoom RATIO across the whole (dynamic) range — uniform control
  // whether nudging 1.0×→1.1× or pulling a long song all the way out to fit.
  const drag = useInertialDrag({
    axis: "x",
    unitsPerPixel: SENSITIVITY,
    bounds: [Math.log(spreadMin), Math.log(spreadMax)],
    origin: () => Math.log(spread),
    onScrub: (logV) => {
      const v = Math.exp(logV);
      lastValue.current = v;
      setSpread(v);
    },
    // A sub-default fit-zoom is a transient per-song view, not a saved note-size
    // preference — only in-range values write back to the global config.
    onSettle: () => {
      if (lastValue.current >= SPREAD_MIN) {
        setConfig("spread", lastValue.current);
      }
    },
  });

  // Commit a value the way a settled drag does: live now, and saved globally
  // unless it is a sub-default fit-zoom.
  const commit = (v: number) => {
    lastValue.current = v;
    setSpread(v);
    if (v >= SPREAD_MIN) setConfig("spread", v);
  };
  const presets = [
    // A long song's zoom-out floor sits below the default band: offer it as
    // "fit the whole song".
    ...(spreadMin < SPREAD_MIN
      ? [{ label: "Fit song", value: spreadMin }]
      : []),
    ...SPREAD_PRESETS.filter((v) => v >= spreadMin && v <= spreadMax).map(
      (value) => ({ label: asZoom(value), value }),
    ),
  ];

  return (
    <JogWheel
      icon={<Icon icon={spreadIcon} className="size-3.5" />}
      tooltip="Note spread — drag to zoom, click the value for presets; pull left to fit the whole song"
      drag={drag}
      // Position tracks log(spread) so the ribs travel uniformly per zoom ratio
      // (matching the log-space drag), not faster at high zoom.
      ribOffsetPx={Math.log(spread) * RIB_SCALE}
      readout={asZoom(spread)}
      collapsible
      presets={{ options: presets, onPick: commit }}
      aria={{
        label: "Note spread",
        valueMin: Math.round(spreadMin * 100),
        valueMax: Math.round(spreadMax * 100),
        valueNow: Math.round(spread * 100),
        valueText: asZoom(spread),
      }}
    />
  );
}
