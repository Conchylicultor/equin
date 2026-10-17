import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  HATCH_CLASS,
  HATCH_STYLE,
  minBarSize,
  useGanttContainerContext,
} from "@plugins/debug/plugins/profiling/web";
import {
  pct,
  Placed,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  IncidentBadge,
  incidentColorClass,
} from "@plugins/debug/plugins/trace/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { TimelineHealthPoint } from "../../shared/frames";
import { heatSegments, type HeatKind } from "../internal/heat";
import type { DuressBand, IncidentBand } from "../internal/bands";
import type { TimelineWindow } from "../internal/view-model";
import { wallclockTicks } from "../internal/ticks";

/**
 * The custom Gantt-aligned rows of the Timeline tab. Every row mirrors
 * MultiSpanLane's three-column geometry (w-40 label · flex-1 track · w-16
 * duration) so it stays pixel-aligned with the TimeAxis, and positions its
 * runtime content through the ambient GanttContainer ms→% mapping (zoom-aware
 * for free).
 */
function GanttRow({
  label,
  track,
  trackClassName,
  className,
}: {
  label?: ReactNode;
  /** Absolutely-positioned children of the relative track cell. */
  track: ReactNode;
  trackClassName?: ClassName;
  className?: string;
}): ReactElement {
  return (
    <Stack direction="row" align="center" gap="sm" className={className}>
      {/* Fixed 160px (w-40) label column, rigid so it stays aligned with the
          Gantt time axis (LABEL_WIDTH), mirroring MultiSpanLane. */}
      <div className={cn("w-40 truncate", rigidClass())}>{label}</div>
      {/* The timeline track: the coordinate host for the row's placed children,
          and the cell that takes the row's slack. */}
      <div className={cn("relative", growClass(), trackClassName)}>{track}</div>
      {/* Fixed 64px (w-16) duration-column spacer, rigid so it stays aligned
          with the Gantt time axis (DURATION_WIDTH). */}
      <div className={cn("w-16", rigidClass())} />
    </Stack>
  );
}

/**
 * Absolute HH:MM tick row. The GanttContainer's built-in TimeAxis is
 * window-relative (offsets from 0), so this thin row underneath carries the
 * wall-clock reading. Ticks are generated for the full window; under zoom the
 * out-of-view ones are skipped (the relative axis keeps carrying offsets).
 */
export function WallclockAxis({
  range,
}: {
  range: TimelineWindow;
}): ReactElement {
  const { toLeftFraction, totalMs } = useGanttContainerContext();
  const ticks = wallclockTicks(range);
  return (
    <GanttRow
      className="h-6 border-b"
      trackClassName={cn("h-full")}
      track={ticks.map((tick) => {
        // Under zoom a tick can fall outside the visible window. Culling is the
        // caller's decision, which is why the fraction arrives unclamped.
        const fraction = toLeftFraction(tick.relMs, totalMs);
        if (fraction < 0 || fraction > 1) return null;
        return (
          // `start`, not `center`: the tick BOX's left edge sits on the
          // fraction and only its contents are centered inside it, exactly as
          // TimeAxis places its own ticks.
          <Placed key={tick.relMs} x={{ start: pct(fraction) }} y="fill">
            <Stack direction="col" align="center" gap="none">
              <div className="h-1.5 w-px bg-border" />
              <Text
                as="span"
                variant="caption"
                tone="muted"
                className="tabular-nums"
              >
                {tick.label}
              </Text>
            </Stack>
          </Placed>
        );
      })}
    />
  );
}

/**
 * Thin health heat strip under a lane group: background segments bucketed by
 * event-loop p99 (backend lanes) or the host pressure score (load +
 * compressor); calm stretches stay transparent, and sampler voids (machine
 * sleep, wedged/dead sampler) render as hatched dark segments.
 */
export function HeatStrip({
  label,
  samples,
  range,
  kind,
  cpuCount,
}: {
  label: string;
  samples: TimelineHealthPoint[];
  range: TimelineWindow;
  kind: HeatKind;
  cpuCount: number;
}): ReactElement {
  const { toLeftFraction, toWidthFraction, totalMs } =
    useGanttContainerContext();
  const segments = heatSegments(samples, range, kind, cpuCount);
  return (
    <GanttRow
      className="py-2xs"
      label={
        <Text as="span" variant="caption" tone="muted" className="font-mono">
          {label}
        </Text>
      }
      trackClassName={cn("h-1.5 rounded-full bg-muted/30")}
      track={segments.map((seg, i) => (
        <Placed
          key={i}
          title={seg.title}
          x={{
            start: pct(toLeftFraction(seg.startMs, totalMs)),
            size: pct(toWidthFraction(seg.endMs - seg.startMs, totalMs)),
            minSize: minBarSize(seg.endMs - seg.startMs),
          }}
          y="fill"
          // A dark (no-data) segment is the shared hatch, not a severity color.
          className={seg.kind === "dark" ? HATCH_CLASS : seg.colorClass}
          style={seg.kind === "dark" ? HATCH_STYLE : undefined}
        />
      ))}
    />
  );
}

/** The duress band's tooltip: the trip reason plus its end-edge semantics. */
function duressBandTitle(band: DuressBand): string {
  if (band.open)
    return `${band.label} — open (no clear line yet; possibly live)`;
  if (band.endUnknown)
    return `${band.label} — lapsed; end time unknown (no clear line)`;
  return band.label;
}

/**
 * Translucent full-height vertical bands, painted BEHIND the lanes (mounted
 * via Overlay `behind`, so both sets share one track and overlap freely):
 * one categorical band per multi-event incident (the trace pane's palette),
 * plus one warning-tinted band per duress episode — the "this window is
 * thinned" marker: shed slow-ops/reports inside it are expected to be sparse.
 */
export function IncidentBandLayer({
  bands,
  duress = [],
}: {
  bands: IncidentBand[];
  duress?: DuressBand[];
}): ReactElement {
  const { toLeftFraction, toWidthFraction, totalMs } =
    useGanttContainerContext();
  return (
    <GanttRow
      className="h-full"
      trackClassName={cn("h-full")}
      track={
        <>
          {duress.map((band) => (
            <Placed
              key={band.id}
              title={duressBandTitle(band)}
              x={{
                start: pct(toLeftFraction(band.startMs, totalMs)),
                size: pct(toWidthFraction(band.endMs - band.startMs, totalMs)),
                minSize: minBarSize(band.endMs - band.startMs),
              }}
              y="fill"
              className="bg-warning/15 border-x border-warning/40"
            />
          ))}
          {bands.map((band) => (
            <Placed
              key={band.incidentId}
              x={{
                start: pct(toLeftFraction(band.startMs, totalMs)),
                size: pct(toWidthFraction(band.endMs - band.startMs, totalMs)),
                minSize: minBarSize(band.endMs - band.startMs),
              }}
              y="fill"
              className={cn(
                "rounded-md opacity-15",
                incidentColorClass(band.colorIndex),
              )}
            />
          ))}
        </>
      }
    />
  );
}

/**
 * Duress chips at each episode band's start — labeled with the trip reason,
 * clickable to open the episode in the detail strip. Its own thin row ABOVE
 * the lanes, mirroring IncidentBadgeRow.
 */
export function DuressBadgeRow({
  bands,
  onSelect,
}: {
  bands: DuressBand[];
  onSelect: (id: string) => void;
}): ReactElement {
  const { toLeftFraction, totalMs } = useGanttContainerContext();
  return (
    <GanttRow
      className="py-2xs"
      label={
        <Text as="span" variant="caption" tone="muted" className="font-mono">
          duress
        </Text>
      }
      trackClassName={cn("h-5")}
      track={bands.map((band) => (
        // The badge sizes to its own content, so `y` anchors the top edge only —
        // deliberately not `fill`, which would stretch the chip to the row.
        <Placed
          key={band.id}
          x={{ start: pct(toLeftFraction(band.startMs, totalMs)) }}
          y={{ start: 0 }}
        >
          <Badge
            as="button"
            type="button"
            variant="warning"
            tooltip={duressBandTitle(band)}
            onClick={() => onSelect(band.id)}
          >
            {band.label}
          </Badge>
        </Placed>
      ))}
    />
  );
}

/**
 * Incident chips at each band's start. Rendered as its own thin row ABOVE the
 * lanes (not inside the behind-layer, where lane content would swallow the
 * badge tooltips).
 */
export function IncidentBadgeRow({
  bands,
}: {
  bands: IncidentBand[];
}): ReactElement {
  const { toLeftFraction, totalMs } = useGanttContainerContext();
  return (
    <GanttRow
      className="py-2xs"
      label={
        <Text as="span" variant="caption" tone="muted" className="font-mono">
          incidents
        </Text>
      }
      trackClassName={cn("h-5")}
      track={bands.map((band) => (
        // Top edge only — the chip keeps its own height. See DuressBadgeRow.
        <Placed
          key={band.incidentId}
          x={{ start: pct(toLeftFraction(band.startMs, totalMs)) }}
          y={{ start: 0 }}
        >
          <IncidentBadge info={band} windowSpanMs={band.endMs - band.startMs} />
        </Placed>
      ))}
    />
  );
}
