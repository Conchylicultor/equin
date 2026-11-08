import { listWorktreeDirsSync } from "@plugins/infra/plugins/paths/server";

// Enumerate the worktree log-dir names for the disk-backed sources (boot +
// health JSONL): the main backend reads every worktree's files straight off
// disk, so a wedged backend still shows up.
export function listWorktreeLogDirs(): string[] {
  return listWorktreeDirsSync();
}
