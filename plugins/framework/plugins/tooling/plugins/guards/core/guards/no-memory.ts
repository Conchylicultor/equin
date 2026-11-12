import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { canonicalCommand, redirectionTargets } from "../argv";
import { defineGuard } from "../define-guard";
import { parseShell } from "../parse-shell";
import type { BashInput, FileInput } from "../types";
import { writeTargets } from "./main-writes";

/**
 * Claude Code's auto-memory lives at `~/.claude/projects/<slug>/memory/**`;
 * a checkout's `.claude/memory/**` is the same thing kept in a repo. Agents
 * here must not add to either: a memory reaches one agent on one machine,
 * while the fix it describes belongs in the code, a check, or a CLAUDE.md that
 * every agent reads (see "Don't memorize gotchas" in the root CLAUDE.md).
 */
export function isMemoryPath(p: string): boolean {
  if (p.includes("/.claude/memory/")) return true;
  const prefix = `${HOME_DIR}/.claude/projects/`;
  if (!p.startsWith(prefix)) return false;
  const rest = p.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash !== -1 && rest.slice(slash + 1).startsWith("memory/");
}

/** Removing a memory is cleanup, not adding one — let it through. */
const REMOVAL_CMDS = new Set(["rm", "rmdir", "unlink"]);

function denial(target: string) {
  return {
    blocked: `Blocked write to Claude Code memory: ${target}.`,
    why: "Saving memories is disabled in this project. A memory only reaches one agent; everyone else keeps hitting the same problem.",
    hint: "Do not save a memory. If the user gave feedback or you hit a footgun, tell the user so it gets fixed in the code, a check, or the relevant CLAUDE.md.",
    skipEpilogue: true,
  };
}

export const noMemoryGuard = defineGuard<FileInput & BashInput>({
  name: "no-memory",
  matcher: ["Write", "Edit", "NotebookEdit", "Bash"],
  check(input, ctx) {
    // The file tools take absolute paths, so no cwd fold is needed here.
    if (input.file_path) {
      return isMemoryPath(input.file_path) ? denial(input.file_path) : null;
    }
    if (!input.command) return null;
    for (const call of parseShell(input.command, ctx.cwd).calls) {
      for (const r of redirectionTargets(call)) {
        if (r.kind === "local" && isMemoryPath(r.path)) return denial(r.path);
      }
      const name = canonicalCommand(call.name);
      if (name && REMOVAL_CMDS.has(name)) continue;
      for (const target of writeTargets(call)) {
        if (isMemoryPath(target)) return denial(target);
      }
    }
    return null;
  },
});
