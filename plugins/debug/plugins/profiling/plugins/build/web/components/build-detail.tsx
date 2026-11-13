import { useMemo, useState, type ReactElement } from "react";
import {
  GanttSection,
  ProfilingContext,
  SpanDetail,
  groupByPhase,
  type Span,
} from "@plugins/debug/plugins/profiling/web";
import { buildRunProfile } from "@plugins/build/plugins/build-profiling/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { PaneChrome, PaneMessage } from "@plugins/primitives/plugins/pane/web";
import { BUILD_PHASE_ORDER, BUILD_PHASE_CONFIG } from "../phases";
import { buildProfileDetailPane } from "../panes";

export function BuildProfileDetailBody(): ReactElement {
  const { worktree, buildId } = buildProfileDetailPane.useParams();
  // Read from the worktree's build artifacts on the computer's disk: a host
  // without it says so (`unavailable`).
  const profile = useLive(buildRunProfile, { buildId, worktree });
  const refetch =
    profile.status === "unavailable" ? undefined : profile.refetch;
  const [hovered, setHovered] = useState<Span | null>(null);
  const ctxValue = useMemo(
    () => ({ hovered, setHovered, refreshKey: 0 }),
    [hovered, setHovered],
  );

  return (
    <PaneChrome pane={buildProfileDetailPane}>
      {/* The ready arm pads its own card (`Inset sm`); a state standing in
          for it has nothing padding it, so it opens the pane's reading region. */}
      {foldResource(profile, {
        loading: () => (
          <PaneMessage>
            <Loading />
          </PaneMessage>
        ),
        unavailable: (message) => (
          <PaneMessage>
            <Placeholder tone="muted">{message}</Placeholder>
          </PaneMessage>
        ),
        error: (error) => (
          <PaneMessage>
            {error.kind === "refused" && error.code === "missing" ? (
              <Placeholder tone="muted">
                No profile recorded for this build.
              </Placeholder>
            ) : (
              <ResourceErrorInline
                error={error}
                refetch={refetch}
                variant="block"
                subject="the build profile"
              />
            )}
          </PaneMessage>
        ),
        ready: (data) => {
          if (data.spans.length === 0) {
            return (
              <PaneMessage>
                <Placeholder tone="muted">
                  No profile recorded for this build.
                </Placeholder>
              </PaneMessage>
            );
          }
          const grouped = groupByPhase(data.spans);
          return (
            <ProfilingContext.Provider value={ctxValue}>
              <Inset pad="sm">
                <Clip className="rounded-md border">
                  <GanttSection
                    title="Build"
                    totalMs={data.totalMs}
                    phaseOrder={BUILD_PHASE_ORDER}
                    phaseConfig={BUILD_PHASE_CONFIG}
                    allByPhase={grouped.all}
                    visibleByPhase={grouped.visible}
                  />
                  <SpanDetail span={hovered} />
                </Clip>
              </Inset>
            </ProfilingContext.Provider>
          );
        },
      })}
    </PaneChrome>
  );
}
