import {
  Button,
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useState, useEffect, type ReactNode } from "react";
import {
  ResourceErrorInline,
  useNotificationsChannelStatuses,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { ElapsedTime } from "@plugins/primitives/plugins/relative-time/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { buildHistory, buildRoute } from "@plugins/build/core";
import { isMainCompositionBuild, type BuildRun } from "../../shared";
import { useReloadAdvice, type ReloadAdvice } from "../hooks/use-reload-advice";
import { ReloadButton } from "./reload-button";
import { BuildTray } from "./build-tray";
import { latestRunState } from "../internal/latest-run-state";
import { BuildPopoverContent } from "./build-popover-content";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const buildIcon = symbol("build");

/** Inner component: receives settled history data so hooks run unconditionally with real values. */
function BuildButtonInner({
  open,
  setOpen,
  advice,
  wsStatus,
  historyData,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  advice: ReloadAdvice;
  wsStatus: string;
  historyData: BuildRun[];
}) {
  const latestRun = historyData[0];
  // Only a real verdict turns the toolbar red: a superseded / interrupted /
  // externally-killed run reports no defect, so it must not read "Build failed".
  const runState = latestRunState(latestRun);
  const building = runState === "running";
  const failed = runState === "failed";
  const staleTab =
    advice.kind === "stale" ||
    advice.kind === "outdated" ||
    (advice.kind === "broken" && advice.stale);

  // The label and the Reload pill answer different questions. The label is
  // about the SERVER (what the build is doing); the pill is about THIS TAB
  // (whether it needs a reload), so a plugin that failed to load mid-build still
  // shows the red Reload beside "Building".
  //
  // Priority: an active build wins the label, since the Reload pill already
  // says the tab is stale — so a stale tab mid-build shows the spinner AND the
  // Reload pill side by side. With no build running, a stale tab reads
  // "Server updated"; otherwise the last outcome.
  const status: "idle" | "building" | "restarting" | "updated" | "failed" =
    building && wsStatus !== "open"
      ? "restarting"
      : building
        ? "building"
        : staleTab
          ? "updated"
          : failed
            ? "failed"
            : "idle";

  // A composition build names what it is building: "Building sonata…", or
  // "Building sonata, website…" for a multi-target invocation. A plain build of
  // this checkout's own app has nothing to name. Joined once, and read as a
  // STRING below: `targets` is a fresh array on every push, so depending on it
  // directly would re-fire the trace on every no-op recompute.
  const targetsLabel = latestRun ? latestRun.targets.join(", ") : null;
  const buildingComposition =
    building && latestRun != null && !isMainCompositionBuild(latestRun.targets);
  const label = {
    idle: "Builds",
    building: buildingComposition ? `Building ${targetsLabel}` : "Building",
    restarting: "Server restarting…",
    updated: "Server updated",
    failed: "Build failed",
  }[status];
  const spinning = status === "building" || status === "restarting";

  // Trace the client-side derivation an agent can read without a browser (see
  // plugins/debug/plugins/logs). Captures whether wsStatus ever leaves "open"
  // while building — the original "Server restarting…" investigation.
  useEffect(() => {
    clientLog(
      "build-btn",
      JSON.stringify({
        status,
        building,
        wsStatus,
        staleTab,
        advice: advice.kind,
        targets: targetsLabel,
        finishedAt: latestRun?.finishedAt,
      }),
    );
  }, [
    status,
    building,
    wsStatus,
    staleTab,
    advice.kind,
    targetsLabel,
    latestRun?.finishedAt,
  ]);

  // The look IS the state. At rest, with nothing to say, the control is one
  // quiet icon like the bar's other utilities. Anything to report — a build
  // running, the server updated under this tab, a failed build, a tab that
  // needs a reload — turns it into the tray: the status in words as a ghost
  // button, and a due reload nested at its end as the filled Reload pill.
  const quiet = status === "idle" && advice.kind === "none";
  const reloadDue = advice.kind !== "none";
  const trigger = quiet ? (
    <IconButton icon={buildIcon} label="Builds" />
  ) : (
    <Button
      variant="ghost"
      aspect={status === "idle" ? "icon" : "text"}
      aria-label={status === "idle" ? "Builds" : undefined}
      // Its leading mark (spinner, dot) sits at the tray's start, so that end
      // keeps the plain control padding; only a label that ENDS the tray takes
      // the pill's extra room there. With the Reload pill nested after it, both
      // ends are plain.
      className={cn("rounded-full", !reloadDue && "pill-end")}
    >
      {spinning && <Spinner shape="ring" className="size-3.5" />}
      {status === "failed" && <StatusDot colorClass="bg-destructive-solid" />}
      {status === "idle" ? <Icon icon={buildIcon} className="size-4" /> : label}
      {status === "building" && latestRun && (
        <ElapsedTime
          since={latestRun.startedAt}
          className="text-muted-foreground tabular-nums"
        />
      )}
    </Button>
  );

  const popover = (
    <InlinePopover
      resetOnClose
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      align="end"
      width="3xl"
      padding="none"
    >
      <Stack
        direction="row"
        align="center"
        justify="between"
        gap="none"
        className="border-b px-md py-sm"
      >
        <Text as="span" variant="label">
          Builds
        </Text>
        <ControlSizeProvider size="xs">
          <IconButton
            icon={navIcons.expand}
            label="Open in Debug"
            variant="ghost"
            {...activationProps(
              afterOpen(appLink(buildRoute.link(debugApp, {})), () =>
                setOpen(false),
              ),
            )}
          />
        </ControlSizeProvider>
      </Stack>
      {/* WHERE a row goes is the arm's — a build row opens the build detail, a
          backup row opens the backup detail, and neither is something global
          chrome can name. All this button still owns is its own chrome: closing
          the popover so it does not hang over the pane the click just opened. */}
      <BuildPopoverContent
        variant="popover"
        onRowActivate={() => setOpen(false)}
      />
    </InlinePopover>
  );

  if (quiet) return popover;
  return (
    <BuildTray failed={status === "failed"}>
      {popover}
      <ReloadButton advice={advice} />
    </BuildTray>
  );
}

export function BuildButton() {
  const [open, setOpen] = useState(false);

  // --- Does this tab need a reload? (stale bundle, or a plugin failed to load) ---
  const advice = useReloadAdvice();

  // --- Worktree live-state channel status (backend liveness) ---
  // During a build the `./singularity build` process restarts this very backend,
  // so the worktree channel drops to reconnecting/closed. Guarded by `building`,
  // that gap is what separates "Server restarting…" from "Building…".
  const { worktree: wsStatus } = useNotificationsChannelStatuses();

  // --- Build history (the default window, newest first; preloaded) ---
  const historyResult = useLive(buildHistory);

  // No history yet: no fake "idle" status and no misleading useEffect trace
  // before data arrives, and the popover needs the history, so it cannot open.
  // Two states, never one: still LOADING is the neutral wrench, inert; a read
  // that FAILED is the live error wrench whose click retries (or reloads, when
  // this tab is out of date) — a disabled wrench would read as "loading"
  // forever. Either way the Reload pill stays: whether this tab needs a
  // reload is independent of the history read (and an out-of-date tab is
  // exactly when that read fails).
  let wrench: ReactNode;
  switch (historyResult.status) {
    case "ready":
      return (
        <BuildButtonInner
          open={open}
          setOpen={setOpen}
          advice={advice}
          wsStatus={wsStatus}
          historyData={historyResult.data}
        />
      );
    case "loading":
      wrench = <IconButton icon={buildIcon} label="Builds" disabled />;
      break;
    case "error":
      wrench = (
        <ResourceErrorInline
          variant="icon"
          icon={buildIcon}
          subject="the build history"
          error={historyResult.error}
          refetch={historyResult.refetch}
        />
      );
      break;
  }
  if (advice.kind === "none") return wrench;
  return (
    <BuildTray>
      {wrench}
      <ReloadButton advice={advice} />
    </BuildTray>
  );
}
