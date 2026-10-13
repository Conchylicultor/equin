import { useMemo, useState, type ReactElement } from "react";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  GanttContainer,
  MultiSpanLane,
  formatDuration,
} from "@plugins/debug/plugins/profiling/web";
import {
  Trace,
  type TraceSelection,
} from "@plugins/debug/plugins/trace/plugins/engine/web";
import {
  traceById,
  traceEvents,
  type TraceSnapshot,
} from "@plugins/debug/plugins/trace/plugins/engine/core";
import { overlaps } from "../internal/incidents";
import { triggerVariant } from "../internal/trigger-meta";
import { traceDetailPane } from "../panes";

// Detail render: read one trace's full snapshot by id (the `debug.trace` point
// lookup), then paint the unified Gantt — the trip row (rendered here from the
// generic trigger, naming no class) + one dispatched Trace.Lane per
// snapshot.events section in registry (insertion) order. A bar/chip click
// feeds the shared bottom detail strip. A non-uuid id (a hand-typed or stale
// URL) is answered not-found by the point read itself, like an unknown uuid.
export function TraceDetail({ id }: { id: string }): ReactElement {
  const result = useLiveRow(traceById, id);

  if (result.status === "loading") {
    return (
      <Center axis="both" className="h-full">
        <Loading />
      </Center>
    );
  }
  if (result.status === "error") {
    return (
      <Center axis="both" className="h-full p-2xl text-center">
        <ResourceErrorInline
          variant="block"
          subject="the trace"
          error={result.error}
          refetch={result.refetch}
        />
      </Center>
    );
  }
  if (!result.found) {
    return (
      <Center axis="both" className="h-full p-2xl text-center">
        <Placeholder tone="muted">{`No trace with id "${id}".`}</Placeholder>
      </Center>
    );
  }

  const { snapshot } = result.row;
  return (
    <>
      <AlsoInWindow id={id} snapshot={snapshot} />
      <TraceGantt snapshot={snapshot} />
    </>
  );
}

// "Also in this window" — the sibling traces whose wall-clock window overlaps
// this trace's window, from the same cheap 200-newest metadata window the
// Events tab reads (`debug.traces`, one shared subscription). One-click hop
// between the co-occurring traces of a single incident. The count is a LOWER
// BOUND — rate-limited siblings never persist — so the subtitle says groups may
// be incomplete. Hidden for a solo trace; while the window loads the strip is
// not drawn yet (it is an optional aid above the Gantt, so it claims nothing),
// and a failed read says so with a retry.
function AlsoInWindow({
  id,
  snapshot,
}: {
  id: string;
  snapshot: TraceSnapshot;
}): ReactElement | null {
  const openPane = useOpenPane();
  const list = useLive(traceEvents);

  const siblings = useMemo(() => {
    const end = Date.parse(snapshot.wallTime);
    const self = {
      startMs: end - (snapshot.atMs - snapshot.windowStartMs),
      endMs: end,
    };
    if (list.status === "loading" || list.status === "error") return null;
    return list.data
      .filter((t) => {
        if (t.id === id) return false;
        const tEnd = Date.parse(t.wallTime);
        return overlaps(self, { startMs: tEnd - t.windowSpanMs, endMs: tEnd });
      })
      .map((t) => ({ ...t, deltaS: (Date.parse(t.wallTime) - end) / 1000 }))
      .sort((a, b) => a.deltaS - b.deltaS);
  }, [list, id, snapshot.wallTime, snapshot.atMs, snapshot.windowStartMs]);

  if (list.status === "error") {
    return (
      <div className="border-b px-lg py-sm">
        <ResourceErrorInline
          variant="inline"
          subject="the traces in this window"
          error={list.error}
          refetch={list.refetch}
        />
      </div>
    );
  }
  if (siblings === null || siblings.length === 0) return null;

  return (
    <div className="border-b px-lg py-sm">
      <Stack gap="xs">
        <Text as="div" variant="caption" tone="muted">
          Also in this window ({siblings.length}) — groups may be incomplete
          (siblings can be rate-limited).
        </Text>
        <Stack gap="2xs">
          {/* eslint-disable-next-line data-view/no-adhoc-row-list -- derived related-traces strip in a detail pane; the Events tab is the DataView */}
          {siblings.map((t) => (
            <Row
              key={t.id}
              size="sm"
              title={t.triggerLabel}
              {...openPane.link(
                traceDetailPane,
                { id: t.id },
                { mode: "push" },
              )}
              icon={
                <Badge variant={triggerVariant(t.triggerKind)} mono>
                  {t.triggerKind}
                </Badge>
              }
            >
              <Fill>
                <Text as="span" variant="caption" className="font-mono">
                  {t.triggerLabel}
                </Text>
              </Fill>
              <Text
                as="span"
                variant="caption"
                tone="muted"
                className="tabular-nums"
              >
                {t.deltaS >= 0 ? "+" : ""}
                {t.deltaS.toFixed(1)}s
              </Text>
            </Row>
          ))}
        </Stack>
      </Stack>
    </div>
  );
}

function TraceGantt({ snapshot }: { snapshot: TraceSnapshot }): ReactElement {
  const [selected, setSelected] = useState<TraceSelection | null>(null);
  const totalMs = Math.max(1, snapshot.atMs - snapshot.windowStartMs);

  // Trip row: the triggering op, anchored to the window's right edge (the trip
  // instant). Rendered generically from `trigger` — the pane names no class.
  const tripBar = useMemo(() => {
    const dur = Math.min(snapshot.trigger.durationMs, totalMs);
    return {
      id: "trip",
      startMs: Math.max(0, totalMs - dur),
      durationMs: dur,
      colorClass: "bg-primary",
      treatment: "solid" as const,
    };
  }, [snapshot.trigger.durationMs, totalMs]);

  const sections = Object.entries(snapshot.events);

  return (
    <Stack gap="none">
      <div className="border-b px-lg py-sm">
        <Trace.TriggerSummary.Dispatch trace={snapshot} />
      </div>

      <GanttContainer title="Window" totalMs={totalMs}>
        <div className="border-b bg-primary/5">
          <Stack
            direction="row"
            align="center"
            gap="sm"
            className="px-lg py-xs"
          >
            <div className="size-2.5 rounded-full bg-primary" />
            <Text as="div" variant="caption" className="font-semibold">
              Trip
            </Text>
          </Stack>
          <Stack gap="2xs" className="px-lg pb-sm">
            <MultiSpanLane
              label={snapshot.trigger.label}
              duration={formatDuration(snapshot.trigger.durationMs)}
              bars={[tripBar]}
              onBarClick={() => setSelected(tripSelection(snapshot))}
            />
          </Stack>
        </div>

        {sections.map(([classId, payload]) => (
          <Trace.Lane.Dispatch
            key={classId}
            classId={classId}
            payload={payload}
            trace={snapshot}
            onSelect={setSelected}
          />
        ))}
      </GanttContainer>

      <Sticky edge="bottom" layer="raised" className="border-t bg-muted/50">
        <DetailStrip selection={selected} />
      </Sticky>
    </Stack>
  );
}

function tripSelection(snapshot: TraceSnapshot): TraceSelection {
  const t = snapshot.trigger;
  return {
    title: `trip · ${t.kind}:${t.label}`,
    fields: [
      { label: "duration", value: formatDuration(t.durationMs) },
      { label: "threshold", value: formatDuration(t.thresholdMs) },
      {
        label: "over budget",
        value:
          t.thresholdMs > 0
            ? `×${(t.durationMs / t.thresholdMs).toFixed(1)}`
            : "—",
      },
      { label: "worktree", value: snapshot.worktree },
    ],
  };
}

// The shared bottom strip: whatever lane last reported a selection, rendered
// generically (title + labelled fields). Class-agnostic — the pane never knows
// what produced it.
function DetailStrip({
  selection,
}: {
  selection: TraceSelection | null;
}): ReactElement {
  return (
    <Text as="div" variant="caption" className="px-lg py-sm">
      {selection ? (
        <Stack direction="row" gap="md" wrap align="baseline">
          <span className="font-mono font-medium">{selection.title}</span>
          {selection.fields.map((f) => (
            <span key={f.label}>
              <span className="text-muted-foreground">{f.label}: </span>
              <span className="font-medium">{f.value}</span>
            </span>
          ))}
        </Stack>
      ) : (
        <span className="text-muted-foreground/60">
          Click a span or chip to see details.
        </span>
      )}
    </Text>
  );
}
