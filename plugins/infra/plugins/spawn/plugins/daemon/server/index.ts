import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { defineDaemon } from "./internal/define";
export {
  DEFAULT_BACKOFF,
  backoffPolicy,
  daemonRecentRuns,
  listDaemons,
  onDaemonActivity,
  pidAlive,
  readPidFile,
} from "./internal/registry";
export type {
  AttachOptions,
  DaemonArm,
  DaemonDecl,
  DaemonDeclBase,
  DaemonInstance,
  DaemonInstanceInfo,
  DaemonRestart,
  DaemonSnapshot,
  DaemonSpec,
  DaemonStartedBy,
  DaemonState,
  DaemonTransition,
  DaemonWhere,
  DetachedLaunch,
  PidFileRead,
  ProcessLaunch,
  UnsupervisedDeclExtras,
  WorkerDaemonInstance,
  WorkerLaunch,
  WorkerLaunchContext,
} from "./internal/registry";

export default {
  description:
    "defineDaemon: the one declared long-lived process or thread a backend runs on its own — a named, described declaration (startedBy boot | on-demand, where every-worktree | main | host-singleton, restart never | backoff) whose spawnProcess / spawnWorker supervise a child process or Bun Worker (one respawn loop: doubling backoff, give-up after repeated rapid exits, healthy on survival or a ready signal), and whose launchDetached / attach follow a detached process by its pid file. Records per declaration its instances (pid, since, restarts, last exit) and each incarnation as a run for the Background activity catalog (onDaemonActivity / listDaemons / daemonRecentRuns).",
} satisfies ServerPluginDefinition;
