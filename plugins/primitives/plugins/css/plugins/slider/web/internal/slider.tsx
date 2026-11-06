import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import "./slider.css";

export interface SliderProps extends Passthrough<HTMLInputElement> {
  /** Current value, in the caller's own units — anywhere in `[min, max]`. */
  value: number;
  /** Low end of the range. Required: the fill is normalized against it. */
  min: number;
  /** High end of the range. Required: the fill is normalized against it. */
  max: number;
  /**
   * Granularity of the value. Omitted means continuous (`step="any"`), NOT the
   * HTML default of 1 — silently quantizing a 0–2 fader to three positions is
   * not a sane thing for an absent prop to do.
   */
  step?: number;
  /**
   * The home position: a tick on the track, plus a magnetic zone that pulls a
   * move landing near it onto it exactly. This is what makes unity findable on
   * a fader that can be pushed past it. Must lie within `[min, max]`.
   */
  detent?: number;
  /**
   * Which way the value runs: `horizontal` (the default, low at the left) or
   * `vertical` (low at the bottom — a volume capsule). The track geometry and
   * the thumb's travel belong to the slider, never to a rotation applied by
   * the caller: a rotated box keeps its unrotated layout size, so the caller
   * would be sizing the wrong axis.
   *
   * Vertical draws its own track, inset so that its round caps are centred
   * exactly where the thumb's centre stops (half a thumb from either end): a
   * vertical slider sits in a capsule whose round ends are concentric with
   * those stops, and a full-length track would poke past them. Size it with
   * `className` (`h-full`, a flex share) — the wrapper is the column.
   */
  orientation?: "horizontal" | "vertical";
  /** Fired with the new value, already snapped to `detent` where it applies. */
  onValueChange: (value: number) => void;
  /**
   * Required: a bare range input has no accessible name, and nothing about a
   * naked track says what it is a level OF.
   */
  "aria-label": string;
  /** Sizing for the slider's box — `w-24`, `w-full`. Lands on the wrapper. */
  className?: string;
}

/**
 * The thin-track slider: a themed `<input type="range">`.
 *
 * It exists because the recipe underneath it — strip the UA appearance, paint a
 * 3px track, a gradient fill for WebKit and a real progress element for
 * Firefox, a focus ring reached through two vendor pseudo-elements — is forty
 * lines of CSS that was being copied per call site. And because two of the
 * things that recipe needs are decisions no call site should be making.
 *
 * **The fill is normalized here.** Every copy of this used to write
 * `--fill: value * 100` inline, which is the right number only because both
 * their ranges happened to be 0–1: correct twice, by coincidence. The first
 * slider with any other range would have painted a filled portion that
 * disagreed with its own thumb, and nothing would have said so. The percentage
 * is a function of `(value, min, max)`, so it is computed in the one place all
 * three are known.
 *
 * **The detent is here too**, for the same reason from the other side: putting
 * a tick at a value means positioning against the track's own geometry, which
 * is knowledge belonging to whoever wrote the track — not to a feature that
 * just wants a fader with a home position.
 *
 * The passthrough and `ref` land on the input, which is the control: that is
 * where a caller's `disabled`, `title`, pointer handlers or `data-*` selector
 * target want to be. `className` is routed to the wrapper instead, because the
 * wrapper is the box — it is what a caller is sizing when they write `w-24`.
 * The wrapper is rendered whether or not there is a detent, so that routing
 * never moves.
 */
export function Slider({
  value,
  min,
  max,
  step,
  detent,
  orientation = "horizontal",
  onValueChange,
  className,
  ref,
  ...rest
}: SliderProps): ReactElement {
  if (detent !== undefined && (detent < min || detent > max)) {
    // Loud, because both of its symptoms are quiet: the tick pins itself to
    // whichever end of the track it was clamped against, and the magnetic zone
    // covers values the slider cannot reach, so it never fires. Nothing looks
    // broken — the fader just has a mark in the wrong place.
    throw new Error(
      `Slider: detent ${detent} lies outside the range [${min}, ${max}].`,
    );
  }

  // Two steps of travel is wide enough for the detent to feel magnetic under a
  // pointer. With no step there is no unit of travel, so the zone falls back to
  // a small share of the range.
  const zone = step === undefined ? (max - min) / 100 : step * 2;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = Number(event.target.value);
    onValueChange(snapToDetent(raw, value, detent, zone));
  };

  const style = {
    "--slider-fill": toPercent(value, min, max),
    "--slider-detent":
      detent === undefined ? undefined : toPercent(detent, min, max),
  } as CSSProperties;

  return (
    <span
      className={cn("slider", className)}
      style={style}
      data-orientation={orientation}
    >
      {orientation === "vertical" ? <span className="slider-rail" /> : null}
      <input
        {...rest}
        ref={ref}
        type="range"
        aria-orientation={orientation}
        min={min}
        max={max}
        // `step="any"` rather than leaving the attribute off: an absent `step`
        // means 1 to the browser, which would quantize a fine-grained range
        // down to a handful of positions.
        step={step ?? "any"}
        value={value}
        onChange={handleChange}
        className="slider-input"
      />
      {detent === undefined ? null : (
        <span className="slider-marks">
          <span className="slider-detent" />
        </span>
      )}
    </span>
  );
}

/**
 * Where a value sits on the track, as 0–100. Clamped, so a value from outside
 * the range paints a full or an empty track rather than a fill running past its
 * own ends. A degenerate range (`max === min`) has no position to report and
 * reads as empty — the one case where the division is undefined.
 */
function toPercent(value: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return 0;
  return Math.min(100, Math.max(0, ((value - min) / span) * 100));
}

/**
 * The magnet: a move landing inside the detent's zone is pulled onto the detent
 * exactly.
 *
 * The second condition — the move must bring the value STRICTLY CLOSER to the
 * detent — is what stops the magnet becoming a trap. A zone wide enough to
 * catch a pointer drag is necessarily several steps wide, so without it,
 * stepping away from the detent with an arrow key would land back inside the
 * zone and be pulled home again, and the value could never leave. Catching only
 * inbound moves means walking out is always allowed, and it also keeps the snap
 * monotone: the value only ever travels further in the direction that was
 * asked for, never back against it.
 */
function snapToDetent(
  raw: number,
  current: number,
  detent: number | undefined,
  zone: number,
): number {
  if (detent === undefined) return raw;
  const distance = Math.abs(raw - detent);
  const inbound = distance < Math.abs(current - detent);
  return inbound && distance <= zone ? detent : raw;
}
