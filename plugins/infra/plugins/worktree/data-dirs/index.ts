import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The host-wide index of running ops: one hard link per live op marker,
 * `<slug>~<opId>.json`, beside the marker's own `worktrees/<slug>/ops/<opId>.json`.
 *
 * A hard link, so it IS the marker — same inode, same flock — and probing it
 * answers exactly what probing the marker does. It exists so "what is running
 * on this host" reads one directory holding the live ops, instead of the ops
 * dir of every worktree that ever existed.
 */
export const liveOpsDir = defineDataDir({
  kind: "locks",
  name: "live-ops",
  owner: "infra/worktree",
  description:
    "Host-wide index of running ops (build / push / check / test / e2e): a hard link of each live op marker, so listing every running op reads one directory of the live ones rather than every worktree's ops dir",
  // Deleting it while an op runs hides that op from the host-wide listing (the
  // stop guard, the machine-usage attribution) until it ends; once nothing runs
  // it holds nothing.
  reclaim: { kind: "restart" },
});

export default [liveOpsDir];
