import { listActiveWorktreeOps } from "@plugins/infra/plugins/worktree/server";
import { liveOpsDir } from "@plugins/infra/plugins/worktree/data-dirs";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import {
  IdleBlocker,
  requestIdleEvaluation,
} from "@plugins/infra/plugins/host/plugins/idle/server";
import { opsReading } from "./reading";

// Not the op log (`op_log_ops`): a ledger whose emptiness is no evidence that
// nothing runs. The flocked markers ARE the liveness.
export const opsIdleBlocker = IdleBlocker({
  id: "ops",
  read: async () => opsReading(await listActiveWorktreeOps()),
});

export const liveOpsWatcher = defineFileWatcher({
  name: "host-idle.live-ops",
  description:
    "Watches the host's running-op markers, so the idle signal re-checks whenever a build, push, check or test starts or ends.",
  extensions: [".json"],
});

let watcher: FileWatcher | null = null;

/** Main only: the one evaluator's input. */
export async function startOpsWatch(): Promise<void> {
  if (!isHostSingleton() || watcher) return;
  const dir = await liveOpsDir.ensure();
  watcher = await liveOpsWatcher.start({
    dirs: [dir],
    onChange: () => requestIdleEvaluation(),
    onLost: () => requestIdleEvaluation(),
  });
}

export async function stopOpsWatch(): Promise<void> {
  if (!watcher) return;
  await watcher.stop();
  watcher = null;
}
