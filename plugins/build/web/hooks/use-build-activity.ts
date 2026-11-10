import type { Activity } from "@plugins/primitives/plugins/css/plugins/activity-ring/web";
import { useNotificationsChannelStatuses } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { buildHistory } from "@plugins/build/core";
import { isMainCompositionBuild } from "../../core";
import { latestRunState } from "../internal/latest-run-state";
import { useServerBehind } from "./use-reload-advice";

/**
 * The build as background work, for the collapsed floating bar's ring
 * (`ActionBar.Activity`): running while the newest run has no verdict, failed
 * while its verdict is a real failure or the server's code is behind the bundle
 * it serves, else nothing. Words match the Build button's label.
 *
 * A history that is still loading or failed to load shows no ring: the ring is
 * an ornament on the health dot, not a claim that no build exists, and the
 * Build button (one hover away) renders the loading / error state itself.
 */
export function useBuildActivity(): Activity | null {
  const history = useLive(buildHistory);
  const { worktree } = useNotificationsChannelStatuses();
  const serverBehind = useServerBehind();
  switch (history.status) {
    case "loading":
      return null;
    case "error":
      // Rendered by the Build button (its retry wrench), one hover away.
      return null;
    case "ready":
      break;
  }
  const latestRun = history.data[0];
  const state = latestRunState(latestRun);
  if (state !== "running" && serverBehind.behind) {
    return { state: "failed", label: "Server out of date" };
  }
  if (state === null || latestRun === undefined) return null;
  if (state === "failed") return { state, label: "Build failed" };
  // During a build the CLI restarts this very backend; the dropped channel is
  // what tells the two apart, exactly as the Build button reads it.
  if (worktree !== "open") return { state, label: "Server restarting…" };
  return {
    state,
    label: isMainCompositionBuild(latestRun.targets)
      ? "Building"
      : `Building ${latestRun.targets.join(", ")}`,
  };
}
