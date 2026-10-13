import { useEffect, useRef, type ReactElement } from "react";
import {
  GanttSection,
  groupByPhase,
  useProfilingContext,
  type PhaseConfig,
} from "@plugins/debug/plugins/profiling/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DataTable,
  type ColumnDef,
} from "@plugins/primitives/plugins/data-table/web";
import {
  bootProfiling,
  type ProfilingData,
  type MemoryCheckpoint,
} from "../../core";

const PHASE_ORDER = [
  "register",
  "awaitPgReady",
  "runMigrations",
  "routePopulation",
  "socketBind",
  "onReadyBlocking",
  "onReady",
  "onAllReady",
];

const PHASE_CONFIG: Record<string, PhaseConfig> = {
  register: {
    label: "Register (sequential)",
    color: "bg-categorical-1",
    bg: "bg-categorical-1/10",
  },
  awaitPgReady: {
    label: "Await PG Ready",
    color: "bg-categorical-2",
    bg: "bg-categorical-2/10",
  },
  runMigrations: {
    label: "Run Migrations",
    color: "bg-categorical-3",
    bg: "bg-categorical-3/10",
  },
  routePopulation: {
    label: "Route Population",
    color: "bg-categorical-4",
    bg: "bg-categorical-4/10",
  },
  socketBind: {
    label: "Socket Bind",
    color: "bg-categorical-5",
    bg: "bg-categorical-5/10",
  },
  onReadyBlocking: {
    label: "onReadyBlocking (parallel)",
    color: "bg-categorical-6",
    bg: "bg-categorical-6/10",
  },
  onReady: {
    label: "onReady (parallel)",
    color: "bg-categorical-7",
    bg: "bg-categorical-7/10",
  },
  onAllReady: {
    label: "onAllReady (parallel)",
    color: "bg-categorical-8",
    bg: "bg-categorical-8/10",
  },
};

function fmtMb(mb: number): string {
  return `${mb.toFixed(1)} MB`;
}

function fmtDelta(mb: number): string {
  const sign = mb >= 0 ? "+" : "";
  return `${sign}${mb.toFixed(1)} MB`;
}

function deltaClass(mb: number): string {
  if (mb > 0.05) return "text-destructive";
  if (mb < -0.05) return "text-success";
  return "text-muted-foreground";
}

interface CheckpointRow {
  label: string;
  physFootprintMb: number;
  delta: number | null;
  atMs: number;
  detail: string;
}

const CHECKPOINT_COLUMNS: ColumnDef<CheckpointRow>[] = [
  { id: "label", header: "Boundary", value: (r) => r.label },
  {
    id: "footprint",
    header: "Footprint",
    align: "end",
    width: "7rem",
    value: (r) => r.physFootprintMb,
    cell: (r) => fmtMb(r.physFootprintMb),
  },
  {
    id: "delta",
    header: "Δ Footprint",
    align: "end",
    width: "7rem",
    value: (r) => r.delta ?? 0,
    cell: (r) =>
      r.delta === null ? (
        <span className="text-muted-foreground">baseline</span>
      ) : (
        <span className={deltaClass(r.delta)}>{fmtDelta(r.delta)}</span>
      ),
  },
  {
    id: "at",
    header: "At",
    align: "end",
    width: "6rem",
    value: (r) => r.atMs,
    cell: (r) => `+${r.atMs}ms`,
  },
  { id: "detail", header: "heap · ext · arrBuf", value: (r) => r.detail },
];

interface PhaseDeltaRow {
  phase: string;
  label: string;
  delta: number;
}

const PHASE_DELTA_COLUMNS: ColumnDef<PhaseDeltaRow>[] = [
  { id: "phase", header: "Phase", value: (r) => r.label },
  {
    id: "delta",
    header: "Δ Footprint",
    align: "end",
    width: "7rem",
    value: (r) => r.delta,
    cell: (r) => (
      <span className={deltaClass(r.delta)}>{fmtDelta(r.delta)}</span>
    ),
  },
];

/**
 * Per-phase phys_footprint delta (sum of physFootprintEndMb - physFootprintStartMb
 * over the phase's spans) and the phase-boundary checkpoint timeline.
 *
 * CAVEAT: onReadyBlocking / onReady plugins run under Promise.all, so the
 * per-span (per-plugin) footprint deltas summed here overlap in wall-clock time
 * and are only directional. The phase-boundary checkpoints (boot-start →
 * after-import → after-onReadyBlocking → after-onReady → after-onAllReady) are
 * the authoritative numbers.
 */
function MemorySummary({
  spans,
  checkpoints,
}: {
  spans: ProfilingData["spans"];
  checkpoints: MemoryCheckpoint[];
}): ReactElement | null {
  if (checkpoints.length === 0 && spans.length === 0) return null;

  const checkpointRows: CheckpointRow[] = checkpoints.map((cp, i) => {
    const prev = i > 0 ? checkpoints[i - 1] : undefined;
    return {
      label: cp.label,
      physFootprintMb: cp.physFootprintMb,
      delta: prev ? cp.physFootprintMb - prev.physFootprintMb : null,
      atMs: cp.atMs,
      detail: `heap ${fmtMb(cp.heapUsedMb)} · ext ${fmtMb(cp.externalMb)} · arrBuf ${fmtMb(cp.arrayBuffersMb)}`,
    };
  });

  // Per-phase footprint delta from per-span attribution (directional only).
  const phaseDelta = new Map<string, number>();
  for (const span of spans) {
    if (
      span.physFootprintStartMb === undefined ||
      span.physFootprintEndMb === undefined
    )
      continue;
    const prev = phaseDelta.get(span.phase) ?? 0;
    phaseDelta.set(
      span.phase,
      prev + (span.physFootprintEndMb - span.physFootprintStartMb),
    );
  }
  const phaseDeltaRows: PhaseDeltaRow[] = PHASE_ORDER.filter((p) =>
    phaseDelta.has(p),
  ).map((phase) => ({
    phase,
    label: PHASE_CONFIG[phase]?.label ?? phase,
    delta: phaseDelta.get(phase)!,
  }));

  return (
    <Inset pad="lg">
      <Stack gap="lg">
        <Stack as="section" gap="sm">
          <SectionLabel>Memory — phase boundaries (authoritative)</SectionLabel>
          <DataTable
            data={checkpointRows}
            columns={CHECKPOINT_COLUMNS}
            rowKey={(r) => r.label}
            emptyLabel="No memory checkpoints recorded."
          />
        </Stack>

        {phaseDeltaRows.length > 0 && (
          <Stack as="section" gap="sm">
            <SectionLabel>
              Per-phase footprint delta (directional — overlapping under
              Promise.all)
            </SectionLabel>
            <DataTable
              data={phaseDeltaRows}
              columns={PHASE_DELTA_COLUMNS}
              rowKey={(r) => r.phase}
              emptyLabel="No per-span footprint attribution."
            />
          </Stack>
        )}
      </Stack>
    </Inset>
  );
}

export function BootSection(): ReactElement | null {
  const { refreshKey } = useProfilingContext();
  // A snapshot: read on mount, re-read on the pane's Refresh.
  const result = useLive(bootProfiling);
  const { refresh } = result;

  // The mount already read it; only a LATER Refresh re-reads.
  const seenKey = useRef(refreshKey);
  useEffect(() => {
    if (seenKey.current === refreshKey) return;
    seenKey.current = refreshKey;
    void refresh();
  }, [refresh, refreshKey]);

  switch (result.status) {
    case "loading":
      return (
        <Inset pad="lg">
          <Loading variant="block" />
        </Inset>
      );
    case "error":
      return (
        <Inset pad="lg">
          <ResourceErrorInline
            variant="block"
            subject="the boot profile"
            error={result.error}
            refetch={result.refetch}
          />
        </Inset>
      );
    case "ready":
      return <BootProfile data={result.data} />;
  }
}

function BootProfile({ data }: { data: ProfilingData }): ReactElement | null {
  // A process that recorded no span has no boot to draw.
  if (data.spans.length === 0) return null;

  const grouped = groupByPhase(data.spans);
  return (
    <div>
      <MemorySummary spans={data.spans} checkpoints={data.memoryCheckpoints} />
      <GanttSection
        title="Boot"
        totalMs={data.totalMs}
        phaseOrder={PHASE_ORDER}
        phaseConfig={PHASE_CONFIG}
        allByPhase={grouped.all}
        visibleByPhase={grouped.visible}
      />
    </div>
  );
}
