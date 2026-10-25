import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Inset, Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { GanttContainer } from "@plugins/debug/plugins/profiling/web";
import { groupIncidents } from "@plugins/debug/plugins/trace/plugins/pane/web";
import { TIMELINE_SOURCES } from "../../core";
import { HOST_LANE } from "../../shared/frames";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { timelineScan, type TimelineScan } from "../../shared/scan";
import {
  buildGroups,
  collectBarEvents,
  LOOKBACK_PRESETS,
  mergeHealth,
  okEvents,
  sourceColorClass,
  type LookbackId,
} from "../internal/view-model";
import { buildBands, duressBands, incidentInputs, intervalEvents } from "../internal/bands";
import { ScanProgress } from "./scan-progress";
import {
  WallclockAxis,
  IncidentBandLayer,
  IncidentBadgeRow,
  DuressBadgeRow,
  HeatStrip,
} from "./gantt-rows";
import { WorktreeGroup } from "./worktree-group";
import { DetailStrip } from "./detail-strip";

/**
 * The Timeline tab of Debug → Slow Events: every worktree's slow events
 * (traces, slow-ops, reports, builds, boots) on one wall-clock Gantt — host
 * lane first, a health heat strip per lane group, and translucent cross-
 * worktree incident bands behind the lanes. One scan per window
 * (`debug.timeline.scan`): asked on mount, on Refresh and on a lookback
 * change — each a new window ending now — and filled in live as the fan-out
 * resolves; a finished scan never moves. Never polled.
 */
export function TimelineView(): ReactElement {
  const [lookback, setLookback] = useState<LookbackId>("1h");
  // The instant the window ends at — the question's `at`. A new one is a new
  // scan, so Refresh and a preset change each take the clock again.
  const [at, setAt] = useState(() => Date.now());
  const lookbackMs = LOOKBACK_PRESETS.find((p) => p.id === lookback)!.ms;
  const read = useLive(timelineScan, { lookbackMs, at });

  const controls = (scanning: boolean): ReactNode => (
    <Stack direction="row" gap="sm" align="center">
      <SegmentedControl
        options={LOOKBACK_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
        value={lookback}
        onChange={(id) => {
          setLookback(id);
          setAt(Date.now());
        }}
      />
      <Button
        variant="outline"
        loading={scanning}
        onClick={() => setAt(Date.now())}
      >
        Refresh
      </Button>
    </Stack>
  );

  switch (read.status) {
    case "loading":
      return (
        <TimelineFrame
          status={<ScanProgress received={0} total={null} />}
          controls={controls(true)}
          body={null}
        />
      );
    case "error":
      return (
        <TimelineFrame
          status={null}
          controls={controls(false)}
          body={
            <Inset pad="lg">
              <ResourceErrorInline
                error={read.error}
                // A failed scan is held as failed: Retry asks a new question
                // (a new `at`), never re-reads the same held scan.
                refetch={async () => setAt(Date.now())}
                variant="block"
                subject="the timeline"
              />
            </Inset>
          }
        />
      );
    case "ready":
      return (
        <TimelineScanView
          scan={read.data}
          controls={controls(!read.data.complete)}
        />
      );
  }
}

/** One scan, as far as it got: the Gantt over the cells and health it holds. */
function TimelineScanView({
  scan,
  controls,
}: {
  scan: TimelineScan;
  controls: ReactNode;
}): ReactElement {
  const { cells: chunks, health } = scan;
  const range = useMemo(
    () => ({ fromMs: scan.fromMs, toMs: scan.toMs }),
    [scan.fromMs, scan.toMs],
  );
  const [selectedBarId, setSelectedBarId] = useState<string | null>(null);
  // The browser runs on the same host as the cluster (single-instance-per-user
  // deployment), so its core count is the honest denominator for load ratios.
  const cpuCount = navigator.hardwareConcurrency || 8;

  const healthByLane = useMemo(() => mergeHealth(health), [health]);
  // Duress episodes are host-global: their ok chunk renders as cross-lane
  // bands + a badge row, never as a worktree lane group (a FAILED duress cell
  // still flows into buildGroups so the error row stays visible).
  const duressEvents = useMemo(
    () => okEvents(chunks.filter((c) => c.source === "duress")),
    [chunks],
  );
  const groupChunks = useMemo(
    () => chunks.filter((c) => !(c.ok && c.source === "duress")),
    [chunks],
  );
  const groups = useMemo(
    () => buildGroups(groupChunks, [...healthByLane.keys()], range),
    [groupChunks, healthByLane, range],
  );
  const barEvents = useMemo(() => collectBarEvents(groups), [groups]);
  const bands = useMemo(() => {
    // ALL interval events across every worktree feed one sweep-union — the
    // cross-worktree correlation falls out of the shared grouping for free.
    const intervals = intervalEvents(okEvents(chunks));
    return buildBands(intervals, groupIncidents(incidentInputs(intervals)), range);
  }, [chunks, range]);
  const duress = useMemo(
    () => duressBands(duressEvents, range),
    [duressEvents, range],
  );

  const hostSamples = healthByLane.get(HOST_LANE);
  const selected =
    selectedBarId !== null
      ? (barEvents.get(selectedBarId) ??
        duressEvents.find((ev) => ev.id === selectedBarId) ??
        null)
      : null;

  const failedCells = chunks.filter((c) => !c.ok).length;
  // Every resolved cell, the empty ones the scan does not keep included.
  const okCells = scan.done - failedCells;
  const eventCount = groups.reduce((n, g) => n + g.eventCount, 0);
  // Events past a cell's cap — the oldest of a busy cell's window.
  const omitted = chunks.reduce((n, c) => n + (c.ok ? c.omitted : 0), 0);
  const isEmpty =
    groups.length === 0 &&
    hostSamples === undefined &&
    duress.length === 0 &&
    scan.complete;

  return (
    <TimelineFrame
      status={
        scan.complete ? (
          <Text as="span" variant="caption" tone="muted">
            {eventCount} event{eventCount === 1 ? "" : "s"} · {okCells} cell
            {okCells === 1 ? "" : "s"} merged
            {failedCells > 0 && (
              <span className="text-warning"> · {failedCells} failed</span>
            )}
            {omitted > 0 && <> · {omitted} older not shown</>}
          </Text>
        ) : (
          <ScanProgress received={scan.done} total={scan.total} />
        )
      }
      controls={controls}
      body={
        isEmpty ? (
          <Inset pad="lg">
            <Placeholder>No events in this window.</Placeholder>
          </Inset>
        ) : (
          <Inset x="md" y="sm">
            <GanttContainer title="Timeline" totalMs={range.toMs - range.fromMs}>
              <WallclockAxis range={range} />
              {duress.length > 0 && (
                <DuressBadgeRow bands={duress} onSelect={setSelectedBarId} />
              )}
              {bands.length > 0 && <IncidentBadgeRow bands={bands} />}
              <Overlay behind={<IncidentBandLayer bands={bands} duress={duress} />}>
                <Stack gap="xs">
                  {hostSamples !== undefined && hostSamples.length > 0 && (
                    <Stack gap="none">
                      <Inset t="xs">
                        <Text as="div" variant="caption" className="font-mono font-medium">
                          {HOST_LANE}
                        </Text>
                      </Inset>
                      <HeatStrip
                        label="pressure"
                        samples={hostSamples}
                        range={range}
                        kind="host"
                        cpuCount={cpuCount}
                      />
                    </Stack>
                  )}
                  {groups.map((group) => (
                    <WorktreeGroup
                      key={group.worktree}
                      group={group}
                      health={healthByLane.get(group.worktree)}
                      range={range}
                      cpuCount={cpuCount}
                      onSelect={setSelectedBarId}
                    />
                  ))}
                </Stack>
              </Overlay>
            </GanttContainer>
          </Inset>
        )
      }
      footer={
        selected !== null ? (
          <DetailStrip event={selected} onClose={() => setSelectedBarId(null)} />
        ) : undefined
      }
    />
  );
}

/**
 * The tab's frame in every state: the scan's progress or summary and the
 * window controls on top, the source legend, then the body (and a detail
 * strip under it).
 */
function TimelineFrame({
  status,
  controls,
  body,
  footer,
}: {
  status: ReactNode;
  controls: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
}): ReactElement {
  return (
    // h-full (not `fill`): the tabbed-view host mounts this inside its scroll
    // body, which is a plain block — h-full bounds the column to the visible
    // area so the header/detail-strip pin and only the lanes scroll.
    <Column
      className="h-full"
      header={
        <Inset x="md" y="sm" className="border-b">
          <Stack gap="xs">
            <Stack direction="row" gap="md" align="center" justify="between">
              <div className="w-64">{status}</div>
              {controls}
            </Stack>
            <Stack direction="row" gap="md" align="center" justify="between">
              <Cluster gap="xs">
                {TIMELINE_SOURCES.filter((s) => s !== "health").map(
                  (source) => (
                    <Badge
                      key={source}
                      variant="muted"
                      mono
                      icon={<StatusDot colorClass={sourceColorClass(source)} />}
                    >
                      {source}
                    </Badge>
                  ),
                )}
                <Badge variant="warning">warning</Badge>
                <Badge variant="destructive">error</Badge>
              </Cluster>
              <Text as="span" variant="caption" tone="muted">
                Sources keep their own retention — traces ≈ 7 d, health ≈ 2 d.
                Hatched strip = no samples (sleep or a dark sampler).
              </Text>
            </Stack>
          </Stack>
        </Inset>
      }
      body={body}
      footer={footer}
    />
  );
}
