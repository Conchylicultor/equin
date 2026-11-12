import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  pct,
  Placed,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { minBarSize } from "./use-gantt-zoom";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { createContext, useContext, type ReactElement } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  formatDuration,
  GanttContainer,
  useGanttContainerContext,
} from "./gantt-container";

export { formatDuration } from "./gantt-container";

export interface Span {
  id: string;
  phase: string;
  plugin?: string;
  label: string;
  startMs: number;
  durationMs: number;
}

export interface PhaseConfig {
  label: string;
  color: string;
  bg: string;
}

export interface ProfilingContextValue {
  hovered: Span | null;
  setHovered: (s: Span | null) => void;
  refreshKey: number;
}

export const ProfilingContext = createContext<ProfilingContextValue | null>(
  null,
);

export function useProfilingContext(): ProfilingContextValue {
  const ctx = useContext(ProfilingContext);
  if (!ctx) throw new Error("useProfilingContext requires ProfilingContext");
  return ctx;
}

export function groupByPhase(spans: Span[]): {
  all: Map<string, Span[]>;
  visible: Map<string, Span[]>;
} {
  const all = new Map<string, Span[]>();
  for (const span of spans) {
    const list = all.get(span.phase) ?? [];
    list.push(span);
    all.set(span.phase, list);
  }
  const visible = new Map<string, Span[]>();
  for (const [phase, list] of all) {
    const nonZero = list.filter((s) => s.durationMs > 0);
    nonZero.sort((a, b) => b.durationMs - a.durationMs);
    visible.set(phase, nonZero);
  }
  return { all, visible };
}

export function GanttSection({
  title,
  totalMs,
  phaseOrder,
  phaseConfig,
  allByPhase,
  visibleByPhase,
}: {
  /** Axis-column label; omit under an already-titled host. See `TimeAxis`. */
  title?: string;
  totalMs: number;
  phaseOrder: string[];
  phaseConfig: Record<string, PhaseConfig>;
  allByPhase: Map<string, Span[]>;
  visibleByPhase: Map<string, Span[]>;
}): ReactElement {
  return (
    <GanttContainer title={title} totalMs={totalMs}>
      {phaseOrder.map((phase) => {
        const allSpans = allByPhase.get(phase);
        if (!allSpans || allSpans.length === 0) return null;
        const config = phaseConfig[phase];
        if (!config) return null;
        return (
          <PhaseGroup
            key={phase}
            config={config}
            allSpans={allSpans}
            spans={visibleByPhase.get(phase) ?? []}
          />
        );
      })}
    </GanttContainer>
  );
}

export function PhaseGroup({
  config,
  allSpans,
  spans,
}: {
  config: PhaseConfig;
  allSpans: Span[];
  spans: Span[];
}): ReactElement {
  const phaseStart = Math.min(...allSpans.map((s) => s.startMs));
  const phaseEnd = Math.max(...allSpans.map((s) => s.startMs + s.durationMs));
  const phaseDuration = phaseEnd - phaseStart;
  const filteredCount = allSpans.length - spans.length;

  return (
    <div className={cn("border-b", config.bg)}>
      <Stack direction="row" align="center" gap="sm" className="px-lg py-xs">
        <div className={cn("size-2.5 rounded-full", config.color)} />
        <Text as="div" variant="caption" className="font-semibold">
          {config.label}
        </Text>
        <Text
          as="div"
          variant="caption"
          className="font-mono tabular-nums text-muted-foreground"
        >
          {formatDuration(phaseDuration)}
        </Text>
        <Text as="div" variant="caption" className="text-muted-foreground">
          +{formatDuration(phaseStart)}
        </Text>
        {filteredCount > 0 && (
          <Text as="div" variant="caption" className="text-muted-foreground/60">
            ({filteredCount} &lt;1ms hidden)
          </Text>
        )}
      </Stack>

      {spans.length > 0 && (
        <Stack gap="2xs" className="px-lg pb-sm">
          {spans.map((span) => (
            <SpanRow key={span.id} span={span} color={config.color} />
          ))}
        </Stack>
      )}
    </div>
  );
}

export function SpanRow({
  span,
  color,
}: {
  span: Span;
  color: string;
}): ReactElement {
  const { toLeftFraction, toWidthFraction, totalMs } =
    useGanttContainerContext();
  const { hovered, setHovered } = useProfilingContext();
  const isHovered = hovered?.id === span.id;
  return (
    <Stack
      direction="row"
      align="center"
      gap="sm"
      className="py-2xs"
      onMouseEnter={() => setHovered(span)}
      onMouseLeave={() => setHovered(null)}
    >
      {/* Fixed 160px (w-40) label column, rigid so it stays aligned with the
          Gantt time axis (LABEL_WIDTH). */}
      <div
        className={cn(
          "w-40 truncate font-mono text-2xs text-muted-foreground",
          rigidClass(),
        )}
      >
        {span.label}
      </div>
      {/* The timeline track: the coordinate host for the bar, clipping what
          overflows it, and the cell that takes the row's slack. */}
      <Clip className={cn("relative h-5 rounded-md bg-muted/30", growClass())}>
        <Placed
          x={{
            start: pct(toLeftFraction(span.startMs, totalMs)),
            size: pct(toWidthFraction(span.durationMs, totalMs)),
            minSize: minBarSize(span.durationMs),
          }}
          y="fill"
          className={cn(
            "rounded-md transition-opacity",
            color,
            isHovered ? "opacity-100" : "opacity-70",
          )}
        />
      </Clip>
      {/* Fixed 64px (w-16) duration column, rigid so it stays aligned with the
          Gantt time axis (DURATION_WIDTH). */}
      <div
        className={cn(
          "w-16 text-right font-mono text-2xs tabular-nums text-muted-foreground",
          rigidClass(),
        )}
      >
        {formatDuration(span.durationMs)}
      </div>
    </Stack>
  );
}

export function SpanDetail({
  span,
  className,
}: {
  span: Span | null;
  className?: string;
}): ReactElement {
  return (
    <Text
      as="div"
      variant="caption"
      // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794237886-rfwccn): a Band only once the profiling pane owns its inset — today it hand-pads, so a Band here would sit on a different edge than its content
      className={cn("border-t bg-muted/50 px-lg py-sm", className)}
    >
      {span ? (
        <Cluster gap="sm">
          <span className="font-mono font-medium">{span.id}</span>
          <span className="text-muted-foreground">&middot;</span>
          <span>
            Phase: <strong>{span.phase}</strong>
          </span>
          <span className="text-muted-foreground">&middot;</span>
          <span>
            Start: <strong>+{formatDuration(span.startMs)}</strong>
          </span>
          <span className="text-muted-foreground">&middot;</span>
          <span>
            Duration: <strong>{formatDuration(span.durationMs)}</strong>
          </span>
        </Cluster>
      ) : (
        <span className="text-muted-foreground/50">
          Hover a span to see details
        </span>
      )}
    </Text>
  );
}
