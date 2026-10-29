import type { OpenPaneFn } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { RunRowProps } from "@plugins/runs/web";
import { sitePane } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { deployRunArm } from "../../core";

/**
 * Where a deploy row goes when it is clicked: its site's Deployments tab — the
 * run's own history, beside the others of the same site.
 *
 * A site is addressed by its own id alone (`site/:deploymentId`, parented on
 * the app's index, which carries no param), so the row needs nothing but the
 * deployment id, whichever of its hosts (the build button's popover, the build
 * and backup panes) it is clicked from.
 *
 * It lives here rather than in the barrel because a barrel may hold only
 * imports, re-exports, type aliases and the single default export.
 */
export function deployRunLink(
  run: RunRowProps["run"],
  openPane: OpenPaneFn,
): LinkTarget {
  // A deploy row always carries its slice (the handle throws otherwise), and
  // its deployment id is NOT NULL there. Not a deploy row is a caller bug.
  const own = deployRunArm.read(run);
  if (own === null) {
    throw new Error(`deployRunLink: run ${run.runKey} is not a deploy run.`);
  }
  return openPane.to(
    sitePane,
    { deploymentId: own.deploymentId, tab: "deployments" },
    // Root, as the sidebar opens a site: a site is a top-level page of the
    // Deploy app, never a column after the list it was clicked from (from the
    // Activity page a push would stack `activity/site/…`).
    { mode: "root" },
  );
}
