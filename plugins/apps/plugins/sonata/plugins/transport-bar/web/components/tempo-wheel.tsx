import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useInertialDrag } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/inertial-drag/web";
import { JogWheel } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/jog-wheel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const speedIcon = symbol("speed");

/** Playback-speed bounds, as authored-tempo fractions (0% … 400%). A frozen 0%
 *  is a stopped transport; 400% is the practical ceiling the stepper also used. */
const MIN_SCALE = 0;
const MAX_SCALE = 4;

/** Tempo units (1 = 100%) per pixel of horizontal drag. Tuned so a full
 *  0%→400% sweep is a comfortable ~650px and a 5% nudge is an easy flick. Unlike
 *  the zoom wheel this scrubs in LINEAR space — tempo reaches 0%, where log-zoom
 *  would diverge — so each pixel adds a constant amount of speed, not a ratio. */
const SENSITIVITY = 0.006;

/** Pixels the ribbed face travels per unit of tempo — chosen so the ribs slide a
 *  wheel-like distance across the [0, 4] range (mirrors the zoom wheel's feel). */
const RIB_SCALE = 50;

const asPercent = (scale: number) => `${Math.round(scale * 100)}%`;

/** Quick-set speeds offered by clicking the readout — the usual practice steps. */
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => ({
  label: asPercent(value),
  value,
}));

/**
 * A horizontal jog wheel for the playback speed, mirroring the piano-roll's zoom
 * `SpreadWheel`: drag it left/right (with release momentum, via the shared
 * inertial-drag primitive) to scrub the live `tempoScale`. The scrub is
 * continuous — `setTempoScale` clamps but does not quantize — so slow drags give
 * fine-grained control and the release fling coasts smoothly; the tidy 0.05 grid
 * is reserved for the ↑/↓ keyboard nudges. The ribbed face slides with the value
 * for a physical-wheel feel.
 */
export function TempoWheel() {
  const { tempoScale, setTempoScale } = useSession();

  const drag = useInertialDrag({
    axis: "x",
    unitsPerPixel: SENSITIVITY,
    bounds: [MIN_SCALE, MAX_SCALE],
    origin: () => tempoScale,
    onScrub: (v) => setTempoScale(v),
  });

  return (
    <JogWheel
      icon={<Icon icon={speedIcon} className="size-3.5" />}
      tooltip="Playback speed — drag to scrub, click the value for presets (↑/↓ to nudge)"
      drag={drag}
      // Position tracks the linear tempo so the ribs travel at a constant rate
      // across the whole range (matching the linear-space drag).
      ribOffsetPx={tempoScale * RIB_SCALE}
      readout={asPercent(tempoScale)}
      collapsible
      presets={{ options: SPEED_PRESETS, onPick: setTempoScale }}
      aria={{
        label: "Playback speed",
        valueMin: Math.round(MIN_SCALE * 100),
        valueMax: Math.round(MAX_SCALE * 100),
        valueNow: Math.round(tempoScale * 100),
        valueText: asPercent(tempoScale),
      }}
    />
  );
}
