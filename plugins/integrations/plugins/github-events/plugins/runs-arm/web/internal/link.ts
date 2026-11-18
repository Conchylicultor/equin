import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { RunRow } from "@plugins/runs/core";
import { githubRunArm } from "../../core";

/**
 * A GitHub run has no detail pane here — its page is GitHub's (jobs, logs,
 * re-run). A click opens it in a new browser tab, as every gesture does.
 */
export function githubRunLink(run: RunRow): LinkTarget {
  const url = githubRunArm.read(run)?.url;
  if (url === undefined)
    throw new Error(`[github runs-arm] run ${run.runKey} is not a GitHub run`);
  return {
    open: () => void window.open(url, "_blank", "noopener"),
    href: () => url,
  };
}
