import type { ReactNode } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  categoricalColor,
  formatAxis,
  formatValue,
  linearScale,
  niceTicks,
  offsetBarPath,
} from "../../core";
import { CHART, MARK, TICK_CLASS, labelEvery } from "../internal/tokens";
import { useBucketCursor } from "../internal/use-bucket-cursor";
import { ChartState } from "./chart-state";
import { ChartTooltip, type TooltipRow } from "./chart-tooltip";

export interface HistogramBin {
  /** Axis label ("$1–5"). */
  label: string;
  /** Tooltip title ("$1 – $5 per conversation"). */
  range: string;
  count: number;
  /** Extra tooltip rows for the bin ("$412 spent in this band"). */
  extra?: readonly { label: string; value: string }[];
}

export interface HistogramProps {
  /** The chart's accessible name. */
  label: string;
  bins: readonly HistogramBin[];
  /** What a count counts ("conversations"), shown after it in the tooltip. */
  countLabel: string;
  /** Default the first categorical slot — one series, one colour. */
  color?: string;
  /** The whole chart's height in px. Default 210. */
  height?: number;
  onPick?: (index: number) => void;
}

const MARGIN = { l: 40, r: 6, t: 8, b: 24 } as const;
const MIN_WIDTH = 120;
/** Histogram bins sit wider than time buckets: there are few of them. */
const MAX_BIN = 40;

/**
 * A distribution: one bar per bin (up to 40px wide, rounded at the top, 1px
 * off the zero line), a hover band + tooltip per bin, and the same keyboard
 * cursor as TimeChart. Counts are non-negative.
 */
export function Histogram({
  label,
  bins,
  countLabel,
  color = categoricalColor(0),
  height = 210,
  onPick,
}: HistogramProps): ReactNode {
  for (const b of bins) {
    if (!(b.count >= 0)) {
      throw new Error(
        `Histogram: bin "${b.label}" has an invalid count (${b.count})`,
      );
    }
  }
  const n = bins.length;
  const [ref, width] = useElementSize((s) => s.width);
  const W = Math.max(width, MIN_WIDTH);
  const iw = W - MARGIN.l - MARGIN.r;
  const ih = height - MARGIN.t - MARGIN.b;
  const band = n > 0 ? iw / n : 0;
  const cursor = useBucketCursor(n, band, onPick);

  if (n === 0) return <ChartState state="empty" height={height} />;

  const ticks = niceTicks(0, Math.max(...bins.map((b) => b.count)), 3);
  const Y = linearScale(
    [0, ticks[ticks.length - 1]!],
    [MARGIN.t + ih, MARGIN.t],
  );
  const X = (i: number) => MARGIN.l + (i + 0.5) * band;
  const bw = Math.max(1, Math.min(MAX_BIN, band - 2));
  const every = labelEvery(n, iw);
  const hover = cursor.active;

  let tip: ReactNode = null;
  if (hover !== null) {
    const b = bins[hover]!;
    const rows: TooltipRow[] = [
      {
        key: "count",
        shape: "rect",
        color,
        value: formatValue("count", b.count),
        label: countLabel,
      },
      ...(b.extra ?? []).map((e, k) => ({
        key: `x${k}`,
        shape: "none" as const,
        value: e.value,
        label: e.label,
      })),
    ];
    tip = <ChartTooltip x={X(hover)} width={W} title={b.range} rows={rows} />;
  }

  return (
    // The positioned host the tooltip's <Placed> resolves against.
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={W}
          height={height}
          role="img"
          aria-label={label}
          className="focus-ring block rounded-md"
          {...cursor.keyboard}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={MARGIN.l}
                x2={W - MARGIN.r}
                y1={Y(t)}
                y2={Y(t)}
                stroke={t === 0 ? CHART.axis : CHART.grid}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                className={TICK_CLASS}
                x={MARGIN.l - 8}
                y={Y(t) + 3.5}
                textAnchor="end"
              >
                {formatAxis("count", t)}
              </text>
            </g>
          ))}
          {hover !== null && (
            <rect
              x={MARGIN.l + hover * band}
              y={MARGIN.t}
              width={band}
              height={ih}
              fill={CHART.hover}
              rx={3}
            />
          )}
          {bins.map((b, i) => {
            const d = offsetBarPath(
              X(i),
              bw,
              Y(0),
              Y(b.count),
              MARK.zeroGap,
              MARK.radius,
            );
            return d ? (
              <path
                key={i}
                d={d}
                fill={color}
                opacity={hover !== null && hover !== i ? MARK.dimOpacity : 1}
                data-mark="bar"
              />
            ) : null;
          })}
          {bins.map((b, i) =>
            i % every === 0 ? (
              <text
                key={i}
                className={TICK_CLASS}
                x={X(i)}
                y={height - 6}
                textAnchor="middle"
              >
                {b.label}
              </text>
            ) : null,
          )}
          <rect
            x={MARGIN.l}
            y={MARGIN.t}
            width={iw}
            height={ih}
            fill="transparent"
            className={onPick ? "cursor-pointer" : undefined}
            data-hit=""
            {...cursor.pointer}
          />
        </svg>
      )}
      {tip}
    </div>
  );
}
