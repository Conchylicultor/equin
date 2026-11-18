import type { ReactNode } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  areaPath,
  assertChartShape,
  colorSeries,
  foldSeries,
  formatAxis,
  formatSigned,
  formatValue,
  linePaths,
  linearScale,
  niceTicks,
  offsetBarPath,
  stackSegments,
  stackTotal,
  valueDomain,
  type ChartBucket,
  type ChartCompare,
  type ChartSeries,
  type ChartUnit,
  type ColoredSeries,
  type PlotPoint,
  type TimeChartKind,
} from "../../core";
import { CHART, MARK, TICK_CLASS, labelEvery } from "../internal/tokens";
import { useBucketCursor } from "../internal/use-bucket-cursor";
import { ChartState } from "./chart-state";
import { ChartTooltip, type TooltipRow } from "./chart-tooltip";
import { Legend } from "./legend";

export interface TimeChartProps {
  /** The chart's accessible name (what it plots). */
  label: string;
  buckets: readonly ChartBucket[];
  /** Up to 10 series draw on their own categorical slot; the tail folds into "Other". */
  series: readonly ChartSeries[];
  kind: TimeChartKind;
  /** The previous period, as a dashed neutral line. */
  compare?: ChartCompare | null;
  /** Formats the axis and the tooltip. Default `count`. */
  unit?: ChartUnit;
  /** The whole chart's height in px, x labels included. Default 240. */
  height?: number;
  /** Click / Enter on a bucket. */
  onPick?: (index: number) => void;
  /** The tooltip's footer when `onPick` is set. */
  pickHint?: string;
  /** Default true; the legend still only shows for ≥ 2 series or a compare line. */
  showLegend?: boolean;
}

const MARGIN = { l: 46, r: 10, t: 8, b: 24 } as const;
/** Below this the plot has no room; the svg keeps this width and clips. */
const MIN_WIDTH = 120;

const BAR_KINDS: ReadonlySet<TimeChartKind> = new Set([
  "stack",
  "mirror",
  "net",
]);

/**
 * One chart for every time series: `area` / `line` (a 2px line per series, area
 * adds a 10% wash), `stack` (stacked columns, a 2px surface gap between
 * segments, only the top rounded), `mirror` (the first series up, the second
 * down) and `net` (one signed series, green up / red down). A `compare` line
 * overlays the previous period, dashed. A `null` value is a gap, never 0; a
 * `partial` bucket is drawn lighter (bars) or dashed (lines).
 *
 * Interactive by default: a hover band (bars) or crosshair (lines) with a
 * tooltip listing every series at that bucket, the same readout on keyboard
 * focus (←/→, Home/End), and `onPick` on click / Enter.
 */
export function TimeChart({
  label,
  buckets,
  series: rawSeries,
  kind,
  compare = null,
  unit = "count",
  height = 240,
  onPick,
  pickHint = "Click for details",
  showLegend = true,
}: TimeChartProps): ReactNode {
  const n = buckets.length;
  assertChartShape(kind, n, rawSeries, compare);
  const series = colorSeries(foldSeries(rawSeries));

  const [ref, width] = useElementSize((s) => s.width);
  const W = Math.max(width, MIN_WIDTH);
  const iw = W - MARGIN.l - MARGIN.r;
  const ih = height - MARGIN.t - MARGIN.b;
  const band = n > 0 ? iw / n : 0;
  const cursor = useBucketCursor(n, band, onPick);

  if (n === 0) return <ChartState state="empty" height={height} />;

  const { lo, hi } = valueDomain(kind, n, series, compare);
  const ticks = niceTicks(lo, hi, 4);
  const Y = linearScale(
    [ticks[0]!, ticks[ticks.length - 1]!],
    [MARGIN.t + ih, MARGIN.t],
  );
  const X = (i: number) => MARGIN.l + (i + 0.5) * band;
  const zeroY = Y(0);
  const bw = Math.max(1, Math.min(MARK.maxBar, band * 0.7, band - 2));
  const every = labelEvery(n, iw);
  const isBars = BAR_KINDS.has(kind);
  const hover = cursor.active;
  const partial = (i: number) => buckets[i]?.partial === true;
  const barOpacity = (i: number) =>
    hover !== null && hover !== i ? MARK.dimOpacity : 1;

  const bar = (key: string, i: number, d: string, fill: string) =>
    d ? (
      <path
        key={key}
        d={d}
        fill={fill}
        opacity={barOpacity(i)}
        fillOpacity={partial(i) ? MARK.partialOpacity : 1}
        data-mark="bar"
        data-partial={partial(i) || undefined}
      />
    ) : null;

  const marks: ReactNode[] = [];
  if (kind === "stack") {
    for (let i = 0; i < n; i++) {
      for (const seg of stackSegments(series, i)) {
        const d = offsetBarPath(
          X(i),
          bw,
          Y(seg.from),
          Y(seg.to),
          seg.from > 0 ? MARK.stackGap : 0,
          seg.top ? MARK.radius : 0,
        );
        marks.push(bar(`${i}-${seg.key}`, i, d, series[seg.index]!.color));
      }
    }
  } else if (kind === "mirror") {
    const [up, down] = series as [ColoredSeries, ColoredSeries];
    for (let i = 0; i < n; i++) {
      const u = nonNegative(up, i);
      const v = nonNegative(down, i);
      if (u)
        marks.push(
          bar(
            `u${i}`,
            i,
            offsetBarPath(X(i), bw, zeroY, Y(u), MARK.zeroGap, MARK.radius),
            up.color,
          ),
        );
      if (v)
        marks.push(
          bar(
            `d${i}`,
            i,
            offsetBarPath(X(i), bw, zeroY, Y(-v), MARK.zeroGap, MARK.radius),
            down.color,
          ),
        );
    }
  } else if (kind === "net") {
    const only = series[0]!;
    for (let i = 0; i < n; i++) {
      const v = only.values[i] ?? null;
      if (!v) continue;
      const d = offsetBarPath(X(i), bw, zeroY, Y(v), MARK.zeroGap, MARK.radius);
      marks.push(bar(`n${i}`, i, d, v > 0 ? CHART.positive : CHART.negative));
    }
  } else {
    for (const s of series) {
      const points = plot(s.values, X, Y);
      const lp = linePaths(points, partial);
      if (kind === "area") {
        lp.runs.forEach((run, k) => {
          const d = areaPath(points, run, zeroY);
          if (d) {
            marks.push(
              <path
                key={`${s.key}-a${k}`}
                d={d}
                fill={s.color}
                opacity={MARK.areaOpacity}
                data-mark="area"
              />,
            );
          }
        });
      }
      if (lp.solid) {
        marks.push(
          <path
            key={`${s.key}-l`}
            d={lp.solid}
            {...lineProps(s.color)}
            data-mark="line"
          />,
        );
      }
      if (lp.dashed) {
        marks.push(
          <path
            key={`${s.key}-p`}
            d={lp.dashed}
            {...lineProps(s.color)}
            strokeDasharray={MARK.partialDash}
            data-mark="line"
            data-partial="true"
          />,
        );
      }
      for (const i of lp.isolated) {
        const p = points[i]!;
        marks.push(
          <Marker key={`${s.key}-i${i}`} x={p.x} y={p.y} color={s.color} />,
        );
      }
    }
  }

  let comparePath: ReactNode = null;
  if (compare) {
    const points = plot(compare.values, X, Y);
    const lp = linePaths(points, () => false);
    comparePath = (
      <g data-mark="compare">
        {lp.solid && (
          <path
            d={lp.solid}
            fill="none"
            stroke={CHART.compare}
            strokeWidth={MARK.compareWidth}
            strokeDasharray={MARK.compareDash}
          />
        )}
        {lp.isolated.map((i) => (
          <circle
            key={i}
            cx={points[i]!.x}
            cy={points[i]!.y}
            r={2}
            fill={CHART.compare}
          />
        ))}
      </g>
    );
  }

  const tip =
    hover === null ? null : (
      <ChartTooltip
        x={X(hover)}
        width={W}
        title={buckets[hover]!.label + (partial(hover) ? " (so far)" : "")}
        rows={tooltipRows(kind, series, compare, hover, unit)}
        footer={onPick ? pickHint : undefined}
      />
    );

  return (
    <Stack gap="sm">
      {showLegend && (
        <Legend
          series={series}
          kind={kind}
          compareLabel={compare?.label ?? null}
        />
      )}
      {/* The positioned host the tooltip's <Placed> resolves against. */}
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
                  {formatAxis(unit, t)}
                </text>
              </g>
            ))}
            {hover !== null && isBars && (
              <rect
                x={MARGIN.l + hover * band}
                y={MARGIN.t}
                width={band}
                height={ih}
                fill={CHART.hover}
                rx={3}
              />
            )}
            {marks}
            {comparePath}
            {hover !== null && !isBars && (
              <g data-mark="crosshair">
                <line
                  x1={X(hover)}
                  x2={X(hover)}
                  y1={MARGIN.t}
                  y2={MARGIN.t + ih}
                  stroke={CHART.axis}
                  strokeWidth={1}
                />
                {series.map((s) => {
                  const v = s.values[hover] ?? null;
                  return v === null ? null : (
                    <Marker key={s.key} x={X(hover)} y={Y(v)} color={s.color} />
                  );
                })}
              </g>
            )}
            {buckets.map((b, i) =>
              i % every === 0 ? (
                <text
                  key={i}
                  className={TICK_CLASS}
                  x={X(i)}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {b.short}
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
    </Stack>
  );
}

/** A 2px round-joined line in the series colour. */
function lineProps(color: string) {
  return {
    fill: "none",
    stroke: color,
    strokeWidth: MARK.line,
    strokeLinejoin: "round",
    strokeLinecap: "round",
  } as const;
}

/** A marker: r = 4 in the series colour, with a 2px surface ring. */
function Marker({
  x,
  y,
  color,
}: {
  x: number;
  y: number;
  color: string;
}): ReactNode {
  return (
    <circle
      cx={x}
      cy={y}
      r={MARK.marker}
      fill={color}
      stroke={CHART.surface}
      strokeWidth={MARK.ring}
      data-mark="marker"
    />
  );
}

function plot(
  values: readonly (number | null)[],
  X: (i: number) => number,
  Y: (v: number) => number,
): PlotPoint[] {
  return values.map((v, i) => (v === null ? null : { x: X(i), y: Y(v) }));
}

/** A mirror series' value at `i`; negative values have no side to go to. */
function nonNegative(s: ChartSeries, i: number): number | null {
  const v = s.values[i] ?? null;
  if (v !== null && v < 0) {
    throw new Error(
      `TimeChart: mirror series "${s.key}" is negative (${v}) at bucket ${i}`,
    );
  }
  return v;
}

function tooltipRows(
  kind: TimeChartKind,
  series: readonly ColoredSeries[],
  compare: ChartCompare | null,
  i: number,
  unit: ChartUnit,
): TooltipRow[] {
  const rows: TooltipRow[] = [];
  const shape = kind === "line" ? "line" : "rect";
  if (kind === "net") {
    const s = series[0]!;
    const v = s.values[i] ?? null;
    rows.push({
      key: s.key,
      shape: "rect",
      color: v !== null && v < 0 ? CHART.negative : CHART.positive,
      value: formatSigned(unit, v),
      label: s.label,
    });
  } else {
    if (kind === "stack" && series.length > 1) {
      rows.push({
        key: "__total",
        shape: "none",
        value: formatValue(unit, stackTotal(series, i)),
        label: "Total",
      });
    }
    // A stack reads top-down in the tooltip, as it does on the chart.
    const ordered = kind === "stack" ? [...series].reverse() : series;
    for (const s of ordered) {
      rows.push({
        key: s.key,
        shape,
        color: s.color,
        value: formatValue(unit, s.values[i] ?? null),
        label: s.label,
      });
    }
  }
  if (compare) {
    rows.push({
      key: "__compare",
      shape: "dash",
      value: formatValue(unit, compare.values[i] ?? null),
      label: compare.label,
    });
  }
  return rows;
}
