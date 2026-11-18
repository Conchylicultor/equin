import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  describeFsmonitorReconcile,
  ensureCheckoutFsmonitor,
  reconcileCheckoutFsmonitors,
  startCheckoutFsmonitor,
  stopCheckoutFsmonitor,
  type FsmonitorCheckout,
  type FsmonitorEnsure,
  type FsmonitorReconcile,
  type FsmonitorStart,
  type FsmonitorStop,
  type FsmonitorToken,
  type FsmonitorWant,
} from "./internal/lifecycle";
export {
  listRunningDaemons,
  listFsmonitorDaemons,
  type FsmonitorDaemon,
  type RunningDaemon,
} from "./internal/daemons";

export default {
  description:
    "The one owner of git's builtin fsmonitor daemons for checkouts: startCheckoutFsmonitor (core.fsmonitor in the checkout's own config.worktree, then the daemon, in a process group of its own so a backend restart does not stop it), ensureCheckoutFsmonitor (the same, plus renewing the index's fsmonitor token when the running daemon did not issue it — a stale token makes every read a full scan, since no read of ours writes the index), stopCheckoutFsmonitor, and reconcileCheckoutFsmonitors (converge every checkout on on / off as its caller says, and signal daemons whose checkout is gone). A git read in a live checkout then costs what changed, not the checkout's ~25k files, however cold the machine's file cache is.",
} satisfies ServerPluginDefinition;
