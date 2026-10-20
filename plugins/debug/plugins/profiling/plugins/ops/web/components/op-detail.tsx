import { useMemo, useState, type ReactElement } from "react";
import {
  GanttContainer,
  MultiSpanLane,
  ProfilingContext,
  SpanDetail,
  SpanRow,
  formatDuration,
  type Span,
} from "@plugins/debug/plugins/profiling/web";
import {
  opFillClass,
  sleepLabel,
  waitFillClass,
  waitLabel,
  waitPlacement,
} from "@plugins/debug/plugins/profiling/plugins/ops/plugins/op-gantt/web";
import {
  toOpRecord,
  type OpRecord,
  type OpStep,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  opRowToFoldState,
  opsHistory,
  type OpRow,
} from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { useSleepNowForFold } from "@plugins/infra/plugins/host/plugins/machine-sleep/web";
import type { SleepNow } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import { stripAttemptBranchPrefix } from "@plugins/infra/plugins/worktree/core";
import {
  Badge,
  formatStatusLabel,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  Text,
  SectionLabel,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { PaneChrome, useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { opDetailPane } from "../panes";

function outcomeVariant(
  outcome: string,
): "success" | "info" | "destructive" | "muted" {
  if (outcome === "success") return "success";
  if (outcome === "waiting" || outcome === "running") return "info";
  if (outcome.startsWith("failed") || outcome === "error") return "destructive";
  return "muted";
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number;
}): ReactElement {
  return (
    <Stack gap="2xs" className="bg-card px-md py-sm">
      <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Text as="span" variant="caption" className="font-mono tabular-nums">
        {formatDuration(value)}
      </Text>
    </Stack>
  );
}

/**
 * The op's full span with every wait at its true in-span offset — the detail
 * twin of the Gantt bar, on the op's OWN wall-clock axis (origin =
 * `requestedAt`). MultiSpanLane's overlays are exactly this model: absolute,
 * bar-relative, free to gap (the op working between its waits) and to repeat a
 * kind (a build re-queuing for the host grant across duress requeue cycles).
 * Every nap the machine slept through is a hatched Asleep overlay on top — over
 * a wait too, since a nap is never a wait.
 */
function OpTimeline({ op }: { op: OpRecord }): ReactElement {
  const bars = useMemo(
    () => [
      {
        id: op.opId,
        startMs: 0,
        durationMs: op.totalMs,
        colorClass: opFillClass(op.kind),
        treatment:
          op.outcome === "waiting" || op.outcome === "running"
            ? ("pulse" as const)
            : ("solid" as const),
        overlays: [
          ...op.waits.map((w) => {
            const at = waitPlacement(w);
            return {
              startMs: at.startMs,
              ms: at.durationMs,
              colorClass: waitFillClass(w.kind),
            };
          }),
          ...op.sleeps.map((sl) => ({
            startMs: sl.startMs,
            ms: sl.durationMs,
            hatched: true as const,
            title: sleepLabel(sl),
          })),
        ],
      },
    ],
    [op],
  );

  // An INTERRUPTED op has no known end (totalMs 0) yet may still carry the waits
  // that were on record when it was killed — so the axis is the furthest point
  // anything actually reaches, not totalMs. For a normal op every wait is inside
  // the span and this collapses to totalMs; for an interrupted one the bar is a
  // sliver at the origin and the waits it died in still render at true offsets,
  // which is the whole reason to keep them.
  const axisMs = Math.max(
    op.totalMs,
    ...op.waits.map((w) => {
      const at = waitPlacement(w);
      return at.startMs + at.durationMs;
    }),
    1,
  );

  return (
    <Clip className="rounded-md border">
      <GanttContainer title="Timeline" totalMs={axisMs}>
        <Stack gap="none" className="px-lg py-sm">
          <MultiSpanLane
            label={op.kind}
            bars={bars}
            duration={formatDuration(op.totalMs)}
          />
        </Stack>
      </GanttContainer>
    </Clip>
  );
}

/**
 * The step breakdown, on the op's WORK axis (origin = `grantedAt`) — a
 * different origin from the waits above, which is why the two are separate
 * charts rather than one.
 *
 * One row per step at its true `startMs`, so concurrency renders AS concurrency:
 * a standalone `check` runs its checks in parallel, so its steps genuinely
 * cluster and overlap rather than forming a waterfall. Rows are ordered by start
 * so reading order matches the clock — but nothing here implies step N+1 waited
 * on step N; two steps that started together start at the same x.
 */
function OpStepsGantt({
  steps,
  holdMs,
  colorClass,
}: {
  steps: OpStep[];
  holdMs: number;
  colorClass: string;
}): ReactElement {
  const [hovered, setHovered] = useState<Span | null>(null);
  const ctxValue = useMemo(
    () => ({ hovered, setHovered, refreshKey: 0 }),
    [hovered, setHovered],
  );
  const spans: Span[] = useMemo(
    () =>
      [...steps]
        .sort((a, b) => a.startMs - b.startMs)
        .map((s, i) => ({
          id: `step:${i}:${s.name}`,
          phase: "work",
          label: s.name,
          startMs: s.startMs,
          durationMs: s.durationMs,
        })),
    [steps],
  );
  const totalMs = Math.max(
    holdMs,
    ...spans.map((s) => s.startMs + s.durationMs),
    1,
  );
  return (
    <ProfilingContext.Provider value={ctxValue}>
      <Clip className="rounded-md border">
        <GanttContainer title="Steps" totalMs={totalMs}>
          <Stack gap="2xs" className="px-lg py-sm">
            {spans.map((s) => (
              <SpanRow key={s.id} span={s} color={colorClass} />
            ))}
          </Stack>
        </GanttContainer>
        <SpanDetail span={hovered} />
      </Clip>
    </ProfilingContext.Provider>
  );
}

export function OpDetailBody(): ReactElement {
  const { opId } = opDetailPane.useParams();
  const result = useLiveRow(opsHistory, opId);

  return (
    <PaneChrome pane={opDetailPane}>
      {result.status === "loading" ? (
        <Loading />
      ) : result.status === "error" ? (
        <ResourceErrorInline
          variant="inline"
          subject="this op"
          error={result.error}
          refetch={result.refetch}
        />
      ) : result.status === "unavailable" ? (
        <Placeholder tone="muted">{result.message}</Placeholder>
      ) : !result.found ? (
        <Placeholder tone="muted">Op not found.</Placeholder>
      ) : result.row.closedBy === null ? (
        <LiveOpDetail row={result.row} />
      ) : (
        <OpDetailView row={result.row} now={0} sleepNow={null} />
      )}
    </PaneChrome>
  );
}

// An in-flight op's span, open wait and hold grow with `now`, and a nap since
// its last event shows only through the machine's sleep clock; a closed op's
// record depends on neither, so only the in-flight view ticks and reads it.
function LiveOpDetail({ row }: { row: OpRow }): ReactElement {
  const now = useNow(1000);
  const sleepNow = useSleepNowForFold();
  return <OpDetailView row={row} now={now} sleepNow={sleepNow} />;
}

function OpDetailView({
  row,
  now,
  sleepNow,
}: {
  row: OpRow;
  now: number;
  sleepNow: SleepNow;
}): ReactElement {
  const openPane = useOpenPane();
  const data = toOpRecord(opRowToFoldState(row), now, sleepNow);
  if (!data) return <Placeholder tone="muted">Op not found.</Placeholder>;
  const branchShort = stripAttemptBranchPrefix(data.branch);
  return (
    <Stack gap="lg" className="p-lg">
      <Cluster gap="sm">
        <Badge colorClass={`${opFillClass(data.kind)}/15`}>
          {formatStatusLabel(data.kind)}
        </Badge>
        <Text as="span" variant="body" className="truncate font-mono">
          {branchShort}
        </Text>
        <Badge variant={outcomeVariant(data.outcome)}>
          {formatStatusLabel(data.outcome)}
        </Badge>
        {/* The lane explains WHY the op waited: interactive draws from a
                reserved host-CPU floor, background does not. */}
        {data.lane && (
          <Badge variant="muted">{formatStatusLabel(data.lane)} lane</Badge>
        )}
        {data.mode === "from-main" && (
          <Badge variant="warning">from main</Badge>
        )}
        {data.interrupted && <Badge variant="destructive">interrupted</Badge>}
      </Cluster>

      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- fixed 3- or 4-column hairline stat grid: the 1px (gap-px) gaps reveal the bg-border as cell separators, a hairline technique the Grid gap ramp can't express
        className={`grid ${data.asleepMs > 0 ? "grid-cols-4" : "grid-cols-3"} gap-px overflow-hidden rounded-md border bg-border`}
      >
        {/* Wait, Asleep and Work come from the reducer's ONE breakdown: Wait
                is the waits' wall extent minus any nap inside them, Asleep the
                union of the naps (shown only when there was one), and Work the
                rest of the span. Wait + Work + Asleep == Total exactly, for
                every kind — a nap is never counted as a wait or as work.

                Deliberately NOT `holdMs`: it is `completedAt - grantedAt`, and a
                build grants at the build lock ~1ms in, so its later host-grant /
                duress-valve waits sit INSIDE the hold — labelling that "Hold"
                next to "Wait" reads as work and would overstate a stalled
                build's real work by the whole queue time. `holdMs` is still on
                the wire for anyone who wants the entry-ticket hold. */}
        <Stat label="Wait" value={data.waitMs} />
        <Stat
          label="Work"
          value={Math.max(0, data.totalMs - data.waitMs - data.asleepMs)}
        />
        {data.asleepMs > 0 && <Stat label="Asleep" value={data.asleepMs} />}
        <Stat label="Total" value={data.totalMs} />
      </div>

      <OpTimeline op={data} />

      <Stack gap="xs">
        <SectionLabel as="span">Waits</SectionLabel>
        {data.waits.length > 0 ? (
          <Cluster gap="xs">
            {data.waits.map((w, i) => (
              <Badge
                key={`${w.kind}:${i}`}
                colorClass={`${waitFillClass(w.kind)}/15`}
                tooltip={`${waitLabel(w)} · +${formatDuration(waitPlacement(w).startMs)} into the op`}
              >
                {formatStatusLabel(w.kind)} {formatDuration(w.durationMs)}
                {w.cycle > 0 && ` · #${w.cycle}`}
              </Badge>
            ))}
          </Cluster>
        ) : (
          <Placeholder tone="muted">
            Never blocked (or logged before wait attribution).
          </Placeholder>
        )}
      </Stack>

      {data.conversationId && (
        <Text
          as="button"
          variant="caption"
          className={cn(
            selfClass("start"),
            "font-medium text-primary-text hover:underline",
          )}
          {...openPane.link(
            conversationPane,
            { convId: data.conversationId },
            { mode: "push" },
          )}
        >
          Open conversation →
        </Text>
      )}

      {data.steps.length > 0 ? (
        <OpStepsGantt
          steps={data.steps}
          holdMs={data.holdMs}
          colorClass={opFillClass(data.kind)}
        />
      ) : (
        <Placeholder tone="muted">No step breakdown recorded.</Placeholder>
      )}
    </Stack>
  );
}
