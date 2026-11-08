import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { join } from "node:path";

export const TASKPOLICY = "/usr/sbin/taskpolicy";

// darwinbg (`-b`): pins the spawned subtree to the efficiency cores and applies
// the background disk-IO throttle tier. THE single tunable flag point for how
// hard background work is demoted.
//
// Measured on this host class (Apple Silicon, 6 P + 12 E cores, 2026-07-07):
// a fixed-CPU default-priority probe ran ~idle-fast (5.9 s vs 8.2 s idle
// baseline) against 20 `-b` spinners, but got NO protection from
// `-c utility` spinners (13.4 s vs 13.0 s against default-priority spinners).
// Do NOT switch to `-c utility` — it does not protect the interactive main
// backend at all. See research/2026-07-07-global-background-work-priority-isolation.md.
//
// If an IO-heavy spawn (pg_dump/pg_restore, the 77 MB worktree checkout)
// crawls under the background IO throttle, relax here to ["-b", "-t", "0"]
// (keeps the E-core CPU demotion, lifts the disk throttle) and re-measure.
export const DEMOTE_FLAGS = ["-b"];

function prefixTokens(): string[] {
  // Escape hatch + A/B verification harness: disable all demotion host-wide.
  if (readEnv("NO_SPAWN_PRIORITY") === "1") return [];
  // taskpolicy ships with every macOS since 10.9: no probe. A probe was a
  // stat on the spawning thread for every demoted spawn; a host without the
  // binary fails the spawn loudly (ENOENT) instead.
  if (process.platform === "darwin") {
    return [TASKPOLICY, ...DEMOTE_FLAGS, "--"];
  }
  // Non-darwin fallback: CPU nice only (no IO demotion). Fail-open — a spawn
  // must never break because the host lacks a priority tool.
  if (process.platform === "linux") return ["nice", "-n", "10"];
  return [];
}

// Prefix an argv array so the spawned process (and every child it forks —
// darwinbg is inherited) runs demoted below the interactive backends.
// Usage: Bun.spawn(backgroundArgv(["pg_dump", ...]), opts)
export function backgroundArgv(argv: string[]): string[] {
  return [...prefixTokens(), ...argv];
}

// Same demotion as a shell-command prefix, for call sites that build a command
// STRING executed by a shell we don't spawn ourselves (e.g. a command handed
// to a long-lived server that forks it — demoting the client would be a no-op). The prefix is a fixed literal, never interpolated data,
// so it is shell-safe by construction.
export function backgroundPrefix(): string {
  const tokens = prefixTokens();
  return tokens.length > 0 ? `${tokens.join(" ")} ` : "";
}

/** The `bin/background-shell` script, beside this code. */
export const BACKGROUND_SHELL = join(
  import.meta.dir,
  "../../bin/background-shell",
);

// The same demotion as a Claude Code `CLAUDE_CODE_SHELL_PREFIX`: the CLI runs
// each command it spawns as `'<prefix>' '<command string>'`, so the prefix is
// one executable taking the whole string — the background-shell script, which
// runs it darwinbg in the CLI's shell. Null where nothing demotes (the escape
// hatch, or a host without taskpolicy): the script knows only taskpolicy.
export function backgroundShellPrefix(): string | null {
  return prefixTokens()[0] === TASKPOLICY ? BACKGROUND_SHELL : null;
}
