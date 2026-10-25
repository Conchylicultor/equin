import { useMemo, useState, type ReactElement } from "react";
import {
  GanttSection,
  SpanDetail,
  ProfilingContext,
  groupByPhase,
  type Span,
  type PhaseConfig,
} from "@plugins/debug/plugins/profiling/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { buildRunProfile } from "../../core";

const PHASE_ORDER = [
  "build:preflight",
  "build:setup",
  "build:codegen",
  "build:database",
  "build:validation",
  "build:checks",
  "build:frontend",
  "build:deploy",
];

const PHASE_CONFIG: Record<string, PhaseConfig> = {
  "build:preflight": { label: "Preflight", color: "bg-categorical-1", bg: "bg-categorical-1/10" },
  "build:setup": { label: "Setup", color: "bg-categorical-2", bg: "bg-categorical-2/10" },
  "build:codegen": { label: "Codegen", color: "bg-categorical-3", bg: "bg-categorical-3/10" },
  "build:database": { label: "Database", color: "bg-categorical-4", bg: "bg-categorical-4/10" },
  "build:validation": { label: "Validation", color: "bg-categorical-5", bg: "bg-categorical-5/10" },
  "build:checks": { label: "Checks", color: "bg-categorical-6", bg: "bg-categorical-6/10" },
  "build:frontend": { label: "Frontend", color: "bg-categorical-7", bg: "bg-categorical-7/10" },
  "build:deploy": { label: "Deploy", color: "bg-categorical-8", bg: "bg-categorical-8/10" },
};

/**
 * A run with no recorded spans has no Gantt to draw. Declared as the
 * contribution's `useAvailable` rather than a `return null` in the body: the
 * host paints the card before it reaches the body, so a null there would leave
 * a "Profiling" bar that opens onto nothing.
 *
 * Absent while the profile is not known yet (the gate is a boolean: the card
 * appears once it lands) and when the run has none (`missing`). A failed read
 * and a host without the computer are shown — the body says which.
 */
export function useHasBuildProfile({ runId }: { runId: string }): boolean {
  const profile = useLive(buildRunProfile, { buildId: runId });
  return foldResource(profile, {
    loading: () => false,
    error: (error) => !(error.kind === "refused" && error.code === "missing"),
    unavailable: () => true,
    ready: (data) => data.spans.length > 0,
  });
}

export function BuildProfilingSection({
  runId,
}: {
  runId: string;
}): ReactElement {
  const profile = useLive(buildRunProfile, { buildId: runId });
  const [hovered, setHovered] = useState<Span | null>(null);
  const ctxValue = useMemo(
    () => ({ hovered, setHovered, refreshKey: 0 }),
    [hovered, setHovered],
  );
  const refetch =
    profile.status === "unavailable" ? undefined : profile.refetch;

  return foldResource(profile, {
    loading: () => <Loading />,
    error: (error) => (
      <ResourceErrorInline
        error={error}
        refetch={refetch}
        variant="inline"
        subject="the build profile"
      />
    ),
    unavailable: (message) => <Placeholder tone="muted">{message}</Placeholder>,
    ready: (data) => {
      const grouped = groupByPhase(data.spans);
      return (
        // No frame and no title of our own: this section is hosted inside the build
        // detail's `SectionCard` ("Profiling"), which already supplies both. The
        // Gantt's own label column then carries just the run's total duration.
        <ProfilingContext.Provider value={ctxValue}>
          <GanttSection
            totalMs={data.totalMs}
            phaseOrder={PHASE_ORDER}
            phaseConfig={PHASE_CONFIG}
            allByPhase={grouped.all}
            visibleByPhase={grouped.visible}
          />
          <SpanDetail span={hovered} />
        </ProfilingContext.Provider>
      );
    },
  });
}
