import { defineGuard } from "../define-guard";
import type { Denial } from "../define-guard";
import { parseShell } from "../parse-shell";
import type { BashInput, GuardContext } from "../types";
import { searchToolWalk, walkOf } from "../walk-roots";
import type { Walk } from "../walk-roots";
import { judgeWalk } from "../walk-scope";

interface SearchToolInput {
  path?: string;
  pattern?: string;
}

function deny(walk: Walk, ctx: GuardContext): Denial | null {
  const verdict = judgeWalk(walk, ctx);
  if (verdict.ok) return null;
  const typed =
    verdict.root.raw === "" ? "(the cwd)" : `\`${verdict.root.raw}\``;
  return {
    blocked: `\`${walk.command}\` would walk ${typed} → \`${verdict.root.path}\`: ${verdict.reason}.`,
    why: "A recursive search outside your worktree can reach the whole home directory — ~/.claude/projects (GBs of transcripts), ~/Downloads, ~290 worktrees with node_modules. Every file it touches goes through the kernel file cache all agents and the app share, so one such walk slows the whole host.",
    allowOnRepeat: true,
    hint: "Search inside your worktree (`rg foo plugins/…`), or name the exact file(s) you mean (`rg foo <dir>/server.jsonl`, `rg foo <dir>/*.log`), or one subdirectory that is bounded — one worktree's data dir, one /tmp dir. To look at a directory's shape, bound the depth: `fd -d 2 . <dir>`, `rg --files --max-depth 2 <dir>`, `ls <dir>`.",
  };
}

const BYPASS = ".allow-wide-search";

/** Every recursive search / walk in a shell command (`rg`, `grep -r`, `fd`, `find`, `du`, …). */
export const searchScopeGuard = defineGuard<BashInput>({
  name: "search-scope",
  matcher: "Bash",
  bypassToken: BYPASS,
  check(input, ctx) {
    if (!input.command) return null;
    for (const call of parseShell(input.command, ctx.cwd).calls) {
      const walk = walkOf(call);
      const denial = walk && deny(walk, ctx);
      if (denial) return denial;
    }
    return null;
  },
});

// One guard per tool: the input does not say which tool it came from, and a
// Grep `pattern` is a regex where a Glob one is a path.
export const grepScopeGuard = defineGuard<SearchToolInput>({
  name: "search-scope-grep",
  matcher: "Grep",
  bypassToken: BYPASS,
  check: (input, ctx) => deny(searchToolWalk("Grep", input, ctx.cwd), ctx),
});

export const globScopeGuard = defineGuard<SearchToolInput>({
  name: "search-scope-glob",
  matcher: "Glob",
  bypassToken: BYPASS,
  check: (input, ctx) => deny(searchToolWalk("Glob", input, ctx.cwd), ctx),
});
