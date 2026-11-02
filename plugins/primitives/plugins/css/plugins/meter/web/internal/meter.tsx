import {
  pct,
  Placed,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/** The fill's colour: what the reading means, not a colour name. */
export type MeterTone = "default" | "warning" | "destructive" | "muted";

/** The bar's thickness. */
export type MeterSize = "default" | "thin";

/** `meter`: a measurement (usage, storage). `progressbar`: a task's progress. */
export type MeterRole = "meter" | "progressbar";

export interface MeterProps {
  /** The filled fraction, 0..1. Clamped when drawn: over 1 draws full. */
  value: number;
  /** The accessible name (`aria-label`). */
  label: string;
  tone?: MeterTone;
  size?: MeterSize;
  /** A target / pace tick drawn across the bar at this fraction (0..1). */
  marker?: number;
  /** The tick's tooltip. */
  markerLabel?: string;
  role?: MeterRole;
  /** `aria-valuetext`: the reading in words ("120 GB of 500 GB"), when a
   * percentage is not what the bar measures. */
  valueText?: string;
  /** Tooltip over the whole bar. */
  title?: string;
  /** Sizing from the caller (a fixed width, `rigidClass()`); composes last. */
  className?: string;
}

const FILL_CLASS: Record<MeterTone, string> = {
  // The accent as it reads on a surface — the palette's text twin of the
  // primary fill, so a deep primary stays visible on a dark surface.
  default: "bg-primary-text",
  warning: "bg-warning",
  destructive: "bg-destructive",
  // A neutral share: present, but no news either way.
  muted: "bg-muted-foreground/50",
};

/**
 * The empty track: a translucent ink over whatever the meter sits on, so it is
 * a visible step off ANY surface by construction — the canvas, a card, the
 * sidebar, a popover, a selected row's fill. A palette fill (`bg-muted`) is
 * calibrated for the canvas only: in Mist the popover IS `--muted`, so an
 * empty meter in a menu drew nothing at all; and a surface-published step
 * (`--hover-fill`) equals a selected row's fill on that same popover.
 */
const TRACK_PAINT = "bg-foreground/10";

const TRACK_CLASS: Record<MeterSize, string> = {
  default: "h-[5px]",
  thin: "h-[3px]",
};

/** How far the tick overhangs the bar, above and below (px). */
const MARKER_OVERHANG: Record<MeterSize, number> = {
  default: 2,
  thin: 1.5,
};

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * A linear meter: a fully-rounded track as wide as its container, filled from
 * the start to `value`. The track never clips, so the `marker` tick can reach
 * past its edges.
 */
export function Meter({
  value,
  label,
  tone = "default",
  size = "default",
  marker,
  markerLabel,
  role = "meter",
  valueText,
  title,
  className,
}: MeterProps) {
  const shown = clamp01(value);
  const overhang = MARKER_OVERHANG[size];
  return (
    <div
      role={role}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      aria-valuetext={valueText}
      title={title}
      className={cn(
        "relative w-full rounded-full",
        TRACK_PAINT,
        TRACK_CLASS[size],
        className,
      )}
    >
      <div
        data-meter-fill=""
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
          FILL_CLASS[tone],
        )}
        style={{ width: pct(shown) }}
      />
      {marker === undefined ? null : (
        <Placed
          data-meter-marker=""
          title={markerLabel}
          x={{ center: pct(clamp01(marker)), size: 1.5 }}
          y={{ start: -overhang, end: -overhang }}
          className="rounded-full bg-foreground/45"
        />
      )}
    </div>
  );
}
