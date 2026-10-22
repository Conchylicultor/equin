import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback } from "react";
import {
  useFetchEndpoint,
  useMachineAvailability,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  buildHistory,
  triggerBuildEndpoint,
  BUILD_LOG_CHANNEL,
} from "../../core";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { LiveLogChannel } from "@plugins/primitives/plugins/log-channels/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { RunsDataView } from "@plugins/runs/web";
// The one declaration of the kind a build run carries — not a literal repeated
// here, which would have gone on silently highlighting nothing after a rename.
// It lives in `run-ledger` (a leaf) rather than in the arm because importing it
// from the arm closed a real plugin-level cycle: `build.web → build/runs-arm`
// against the arm's own `→ build/web`. The boundary checker collapses runtimes
// for cycle detection, which is what made the "different zone.runtime nodes"
// reasoning wrong.
import { BUILD_RUN_KIND } from "@plugins/build/plugins/run-ledger/core";
import { DeploymentChain } from "@plugins/build/plugins/deployment/web";
import type { BuildRun } from "../../shared";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const playArrowIcon = symbol("play-arrow");

// Both build surfaces open on the `active` tab, which is empty whenever nothing
// is in flight — the normal case. The shared surface's own default reads
// "Nothing has run here yet.", which on that tab is a false claim about a
// machine with thousands of recorded runs. Say what is actually true of an empty
// FILTERED list instead. (The real fix belongs in `runs`, whose empty state
// should know whether a filter is narrowing it; until then this is the honest
// wording here.)
const NO_MATCHING_RUNS = <>Nothing matches this view.</>;

function BuildControls({
  building,
  onBuild,
}: {
  building: boolean;
  onBuild: () => void | Promise<void>;
}) {
  // A build spawns `./singularity build` in this checkout: under a host without
  // the computer (the in-browser demo) the button is disabled, its tooltip
  // saying why.
  const availability = useMachineAvailability(triggerBuildEndpoint);
  return (
    <Stack
      direction="row"
      align="center"
      gap="sm"
      className="border-b px-md py-sm"
    >
      <Button
        variant="default"
        loading={building}
        disabled={!availability.available}
        tooltip={availability.available ? undefined : availability.message}
        onClick={() => onBuild()}
      >
        <Icon icon={playArrowIcon} className="size-4" />
        Build
      </Button>
    </Stack>
  );
}

/**
 * The build's live log stream, as a section the popover can keep shut.
 *
 * Shut is the default, and it is what the popover is FOR: you open it to see
 * what is deployed, to start a build, and to read the list of runs — three
 * things a wall of log text used to push below the fold. The one time the logs
 * are the reason you opened it is while a build is running, so the section
 * starts open then. Either way it is one click away, and closing it also drops
 * the log subscription.
 *
 * Everything under the header — the socket, the sequence de-dup, the sticky
 * scroll, the copy button — belongs to the shared `LiveLogChannel` primitive.
 * This file used to carry its own copy of that body, one whose extra mount-time
 * `subscribe` made the server replay the whole ring buffer a second time, so
 * every line showed up twice.
 */
function BuildLogView({ building }: { building: boolean }) {
  const toast = useToast();
  return (
    <LiveLogChannel
      channel={BUILD_LOG_CHANNEL}
      label="Logs"
      disclosure={building ? "open" : "closed"}
      emptyState="No build logs yet"
      // Shorter than the primitive's default: in a popover the run list below
      // has to stay in view.
      className="h-48"
      onError={(error) =>
        toast({
          type: "build",
          title: "Build log error",
          description: error,
          variant: "error",
        })
      }
    />
  );
}

/**
 * Inner: receives settled history so hooks always run with real data.
 *
 * `buildRuns` is here for ONE thing — whether a build of this checkout is in
 * flight, which is what the Build control's spinner says. It is deliberately not
 * the list: the list below is the merged runs surface, which pages every
 * ledger's rows off its own keyset query. The two must not be confused, hence
 * the name.
 */
function BuildPopoverContentInner({
  variant,
  buildRuns,
  selectedRunId,
  onRowActivate,
}: {
  variant: "popover" | "pane";
  buildRuns: BuildRun[];
  selectedRunId?: string;
  onRowActivate?: () => void;
}) {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  const latestRun = buildRuns[0];
  const building = latestRun?.finishedAt === null;

  const handleBuild = useCallback(async () => {
    try {
      const result = await fetchEndpoint(triggerBuildEndpoint, {});
      if (result.kind === "unavailable") {
        // The Build button is disabled under a transport with no computer
        // behind it, so this is not expected — but if it is reached, it says
        // why rather than claiming a build started.
        toast({
          type: "build",
          title: "Build failed to start",
          description: result.message,
          variant: "error",
        });
        return;
      }
      toast({
        type: "build",
        title: "Build started",
        description: "Running ./singularity build",
        variant: "info",
      });
    } catch (err) {
      if (err instanceof EndpointError) {
        toast({
          type: "build",
          title: "Build failed to start",
          description: err.message,
          variant: "error",
        });
      } else {
        toast({
          type: "build",
          title: "Build failed to start",
          description: "Server unreachable",
          variant: "error",
        });
      }
    }
  }, [fetchEndpoint, toast]);

  return (
    <Stack gap="none" className={cn(variant === "pane" && "h-full")}>
      {/* What is actually deployed, above the control that changes it: the
          commit chain with a chip per carrier on the commit it is really on.
          Its verdict is the SAME `convergenceOf` answer the auto-build
          reconciler acts on, so a wrong badge here and a missed rebuild are
          one bug rather than two. */}
      <DeploymentChain />
      <BuildControls building={building} onBuild={handleBuild} />
      {variant === "popover" ? (
        <>
          <Stack gap="none" className="border-b">
            <BuildLogView building={building} />
          </Stack>
          {/* The popover has to supply the history scroll itself. A DataView is
              always natural-height and never opens a scroller, and here there is
              no `PaneChrome` above it to do so — the whole loaded window would
              otherwise push the panel to full viewport height. Capped just above
              the log view's `h-48` so the two read as a pair rather than as a log
              with a wall of history under it. */}
          <Scroll axis="y" className="max-h-64">
            <RunsDataView
              density="compact"
              defaultView="active"
              emptyState={NO_MATCHING_RUNS}
              onRowActivate={onRowActivate}
            />
          </Scroll>
        </>
      ) : (
        <RunsDataView
          emptyState={NO_MATCHING_RUNS}
          // The pair, not the bare id: a run id is only unique inside its own
          // ledger, and the row this pane has open is by construction a build.
          selectedRun={
            selectedRunId === undefined
              ? undefined
              : { kind: BUILD_RUN_KIND, id: selectedRunId }
          }
        />
      )}
    </Stack>
  );
}

export function BuildPopoverContent({
  variant,
  selectedRunId,
  onRowActivate,
}: {
  variant: "popover" | "pane";
  /** The build run whose detail pane is open, highlighted in the list. */
  selectedRunId?: string;
  /**
   * The host's own business after a row click — the toolbar popover closing
   * itself. NOT where the row goes: that is the arm's, and runs first.
   */
  onRowActivate?: () => void;
}) {
  const historyResult = useLive(buildHistory);
  if (historyResult.status === "loading") {
    return (
      <Stack gap="none" className={cn(variant === "pane" && "h-full")}>
        <Loading variant="rows" count={3} />
      </Stack>
    );
  }
  if (historyResult.status === "error") {
    return (
      <Stack gap="none" className={cn(variant === "pane" && "h-full")}>
        <ResourceErrorInline
          variant="block"
          subject="the build history"
          error={historyResult.error}
          refetch={historyResult.refetch}
        />
      </Stack>
    );
  }
  return (
    <BuildPopoverContentInner
      variant={variant}
      buildRuns={historyResult.data}
      selectedRunId={selectedRunId}
      onRowActivate={onRowActivate}
    />
  );
}
