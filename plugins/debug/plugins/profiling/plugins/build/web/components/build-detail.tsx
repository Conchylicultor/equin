import { useMemo, useState, type ReactElement } from "react";
import {
  GanttSection,
  ProfilingContext,
  SpanDetail,
  groupByPhase,
  type Span,
} from "@plugins/debug/plugins/profiling/web";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { BUILD_PHASE_ORDER, BUILD_PHASE_CONFIG } from "../phases";
import { buildProfileDetailPane } from "../panes";
import { getBuildRunProfileByWorktree } from "../../shared/endpoints";

export function BuildProfileDetailBody(): ReactElement {
  const { worktree, buildId } = buildProfileDetailPane.useParams();
  const { data: answer, error } = useEndpoint(getBuildRunProfileByWorktree, {
    worktree,
    buildId,
  });
  // The profile is read from the computer's disk: a host without it says so.
  const data = answer?.kind === "ok" ? answer.value : undefined;
  const [hovered, setHovered] = useState<Span | null>(null);
  const ctxValue = useMemo(
    () => ({ hovered, setHovered, refreshKey: 0 }),
    [hovered, setHovered],
  );

  return (
    <PaneChrome pane={buildProfileDetailPane}>
      {answer?.kind === "unavailable" ? (
        <Placeholder tone="muted">{answer.message}</Placeholder>
      ) : !data ? (
        <Placeholder tone={error ? "error" : "muted"}>
          {error ? "Build profile unavailable." : "Loading…"}
        </Placeholder>
      ) : data.spans.length === 0 ? (
        <Placeholder tone="muted">
          No profile recorded for this build.
        </Placeholder>
      ) : (
        <ProfilingContext.Provider value={ctxValue}>
          <Inset pad="sm">
            <Clip className="rounded-md border">
              {(() => {
                const grouped = groupByPhase(data.spans);
                return (
                  <GanttSection
                    title="Build"
                    totalMs={data.totalMs}
                    phaseOrder={BUILD_PHASE_ORDER}
                    phaseConfig={BUILD_PHASE_CONFIG}
                    allByPhase={grouped.all}
                    visibleByPhase={grouped.visible}
                  />
                );
              })()}
              <SpanDetail span={hovered} />
            </Clip>
          </Inset>
        </ProfilingContext.Provider>
      )}
    </PaneChrome>
  );
}
