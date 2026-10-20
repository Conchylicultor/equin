import { existsSync } from "node:fs";
import { homedir } from "node:os";

export const GIT = Bun.which("git") ?? "git";
export const PGREP = Bun.which("pgrep") ?? "pgrep";
export const PS = Bun.which("ps") ?? "ps";

/**
 * Where Claude Code is looked for when it is not on PATH: its own installer's
 * target, then Homebrew's two prefixes. doctor.sh (framework/cli/plugins/doctor)
 * searches the same list — its doctor.test.ts reads this array to keep them in
 * step.
 */
export const CLAUDE_CANDIDATES = [
  `${homedir()}/.local/bin/claude`,
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

/** Where {@link resolveClaudeBin} looked, or found Claude Code. */
export type ClaudeBinLookup =
  { kind: "found"; path: string } | { kind: "missing"; searched: string[] };

/**
 * Find the Claude Code executable NOW: `$SINGULARITY_CLAUDE_BIN`, else PATH,
 * else {@link CLAUDE_CANDIDATES}.
 *
 * A function, not a constant, and a result, not a string, on purpose. The
 * constant it replaces was resolved once at module load and fell back to the
 * bare word `claude` — so a missing CLI was spelled exactly like a present one
 * and surfaced only as `command not found` inside a dead agent pane, and an
 * install made after the backend started was never seen. The lookup is a few
 * `stat`s (microseconds) and runs only before a Claude process is started,
 * which itself costs hundreds of milliseconds.
 *
 * The override is taken as given, even when nothing is there: whoever set it
 * named the binary to use, and falling back to another one would hide that
 * their choice is broken.
 */
export function resolveClaudeBin(): ClaudeBinLookup {
  const override = process.env.SINGULARITY_CLAUDE_BIN;
  if (override) {
    return existsSync(override)
      ? { kind: "found", path: override }
      : { kind: "missing", searched: [override] };
  }
  const fromPath = Bun.which("claude");
  if (fromPath) return { kind: "found", path: fromPath };
  const hit = CLAUDE_CANDIDATES.find((p) => existsSync(p));
  if (hit) return { kind: "found", path: hit };
  return { kind: "missing", searched: ["$PATH", ...CLAUDE_CANDIDATES] };
}
