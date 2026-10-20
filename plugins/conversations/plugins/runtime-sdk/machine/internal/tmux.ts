import { TMUX } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// The tmux server the sdk runtime hosts its agent processes in: only a
// supervisor and a viewer, never typed into.

export async function tmux(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await spawnCaptured([TMUX, ...args], { timeoutMs: 10_000 });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

export async function hasTmuxSession(id: string): Promise<boolean> {
  return (await tmux(["has-session", "-t", id])).exitCode === 0;
}
