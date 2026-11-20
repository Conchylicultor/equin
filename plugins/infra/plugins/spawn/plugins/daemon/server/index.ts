import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

import { pidFileWatcher } from "./internal/pid-file-watch";

export { defineDaemon } from "./internal/define";
export {
  DEFAULT_BACKOFF,
  backoffPolicy,
  daemonRecentRuns,
  listDaemons,
  liveSupervisedIncarnations,
  onDaemonActivity,
  parsePidFile,
  pidAlive,
  readPidFile,
  stopOnCodeAdopted,
} from "./internal/registry";
export type {
  AttachOptions,
  DaemonArm,
  DaemonDecl,
  DaemonDeclBase,
  DaemonExit,
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
  SpawnedCode,
  SupervisedIncarnation,
  ProcessLaunch,
  ProcessSpawnContext,
  SupervisedDaemonInstance,
  UnsupervisedDeclExtras,
  WorkerDaemonInstance,
  WorkerLaunch,
  WorkerLaunchContext,
} from "./internal/registry";

export default {
  register: [pidFileWatcher],
  description:
    "defineDaemon: the one declared long-lived process or thread a backend runs on its own — a named, described declaration (startedBy boot | on-demand, where every-worktree | main | host-singleton, restart never | backoff) whose spawnProcess / spawnWorker supervise a child process or Bun Worker (one respawn loop: doubling backoff, give-up after repeated rapid exits unless giveUp \"never\", healthy on survival or a ready signal — a process's onSpawn ctx.ready() or a worker's; respawnNow skips a pending wait; exit transitions carry the process's { code, signal }), and whose launchDetached / attach follow a detached process by its pid file. Records per declaration its instances (pid, since, restarts, last exit) and each incarnation as a run for the Background activity catalog (onDaemonActivity / listDaemons / daemonRecentRuns).",
} satisfies ServerPluginDefinition;
