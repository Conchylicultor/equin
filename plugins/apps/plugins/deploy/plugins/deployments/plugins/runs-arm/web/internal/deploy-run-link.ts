import type { OpenPaneFn } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { RunRowProps } from "@plugins/runs/web";
import { deploymentDetailPane } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { deployRunArm } from "../../core";

/**
 * Where a deploy row goes when it is clicked.
 *
 * `deploymentDetailPane` nests under the server page, so opening it needs BOTH
 * ids, and both are spelled here: a pane's params are its route's CHAINED set,
 * so the ancestor's `serverId` is nameable even though this row is nowhere near
 * the server page. An open never discards a param the caller supplied — a
 * relative open materializes any declared ancestor the route does not already
 * hold and whose params the caller named — so `serverId` is what puts
 * `server/<id>` in the URL from all three of this row's hosts (the build
 * button's popover, and inside the build and backup panes). Trimming it to the
 * pane's own id strands the pane without its ancestor.
 *
 * It lives here rather than in the barrel because a barrel may hold only
 * imports, re-exports, type aliases and the single default export.
 */
export function deployRunLink(
  run: RunRowProps["run"],
  openPane: OpenPaneFn,
): LinkTarget {
  // A deploy row always carries its slice (the handle throws otherwise), and
  // both ids are NOT NULL there. Not a deploy row is a caller bug.
  const own = deployRunArm.read(run);
  if (own === null) {
    throw new Error(`deployRunLink: run ${run.runKey} is not a deploy run.`);
  }
  const { serverId, deploymentId } = own;
  return openPane.to(
    deploymentDetailPane,
    { serverId, deploymentId },
    { mode: "push" },
  );
}
