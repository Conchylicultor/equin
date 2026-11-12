import {
  setClientBuildIdentity,
  setServedCentralBuild,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import {
  getServedCentralBuild,
  getServerGraphHash,
} from "./get-server-graph-hash";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";

// The build graph the live-resource runtime judges a contract mismatch against
// (`setClientBuildIdentity`): a tab whose bundle names another graph is out of
// date — skew, warned — while one naming this graph has a real bug — reported.
//
// Read ONCE, at the register phase, and memoized — the one reader here that is
// NOT fresh per call, and deliberately so. The question is "which bundle was
// this PROCESS's code built with?", and `./equin build` swaps the served
// dist before it restarts this backend: a fresh read in that window names the
// NEW bundle while the old code still answers, and would call a current tab's
// mismatch "same-build" (or an old tab's "skew" of the wrong build). At boot
// the dist is already the one built alongside this code.
export const clientBuildIdentityRegistration: Registration = {
  register() {
    return pinClientBuildIdentity();
  },
};

/**
 * Read the served graph now and hold it as this process's build identity: at
 * boot, and again when the process adopts a deploy instead of being restarted
 * for it (`build/restart-skip` — the deploy publishes its dist first, so the
 * graph read then is the one built alongside the code this process was just
 * judged to run).
 */
export async function pinClientBuildIdentity(): Promise<void> {
  const [graph, central] = await Promise.all([
    getServerGraphHash(),
    getServedCentralBuild(),
  ]);
  setClientBuildIdentity(() => graph);
  // Beside it, pinned the same way: the central build of the page published
  // alongside this code — what a reload brings a tab for central's values.
  // Not on main: central runs main's checkout and restarts onto it with each
  // of main's deploys (after main's backend), so a central skew a main tab
  // sees is never a deploy mismatch — the tab is behind (reload) or central
  // is for a moment (the Build tray's server-behind). Naming it would read
  // that moment as a `deploy-skew` no reload fixes, and report it.
  setServedCentralBuild(() => (isMain() ? null : central));
}
