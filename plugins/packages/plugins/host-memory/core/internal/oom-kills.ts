import { parseProcVmstat } from "./proc-meminfo";

// How many processes the kernel's OOM killer has taken since boot — the one
// fact that tells "a child died of SIGKILL because the machine ran out of
// memory" from "something sent it SIGKILL". The kernel's own kill sends a
// plain SIGKILL, indistinguishable at the waiting parent, so the evidence has
// to come from the host: a counter that moved while the process ran.

/**
 * A reading of the host's OOM-kill counter. Never a bare number: a host that
 * cannot say (`unsupported`, `unstated`, `unreadable`) must not read as "no
 * kills", so a caller has to handle each arm to get at a count.
 *
 * - `read` — the system-wide count since boot.
 * - `unsupported` — the OS keeps no such counter (macOS: jetsam kills are in
 *   the unified log, not a counter a process can read).
 * - `unstated` — Linux whose `/proc/vmstat` has no `oom_kill` line (kernels
 *   before 4.13, a sandbox's thin `/proc`).
 * - `unreadable` — the read itself failed.
 */
export type OomKillCount =
  | { kind: "read"; count: number }
  | { kind: "unsupported"; platform: string }
  | { kind: "unstated" }
  | { kind: "unreadable"; error: string };

/** Linux: the `oom_kill` line of a `/proc/vmstat` text, or `unstated`. */
export function oomKillCountFromProcVmstat(text: string): OomKillCount {
  const count = parseProcVmstat(text)["oom_kill"];
  return count === undefined ? { kind: "unstated" } : { kind: "read", count };
}

/**
 * Read the host's OOM-kill counter: `/proc/vmstat`'s `oom_kill` on Linux,
 * `unsupported` elsewhere. Total — a failed read is the `unreadable` arm, not a
 * throw, because its callers (a build bracketing its own run) read it beside
 * the work it explains and must not fail that work for want of an
 * explanation. `platform` is the host's `process.platform`; `readText` reads a
 * file (throwing on failure), supplied by the caller as `core/` reads nothing
 * itself.
 */
export async function readOomKillCount(
  platform: string,
  readText: (path: string) => Promise<string>,
): Promise<OomKillCount> {
  if (platform !== "linux") return { kind: "unsupported", platform };
  let text: string;
  try {
    text = await readText("/proc/vmstat");
  } catch (err) {
    return {
      kind: "unreadable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return oomKillCountFromProcVmstat(text);
}
