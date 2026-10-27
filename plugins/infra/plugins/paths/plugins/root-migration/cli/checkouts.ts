import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  listWorktreeEntries,
  type WorktreeEntry,
} from "@plugins/infra/plugins/worktree/server";
import type { StaleCheckout } from "./plan";

// Which checkouts of this repo could still run code from before the move — the
// fact that decides whether the legacy names may go (see `staleCheckouts` in
// `./plan.ts`).
//
// The probe asks each checkout's HEAD whether it HAS the capability, not
// whether it descends from the commit that added it: a checkout whose code
// decides the data root by what is installed follows `~/.equin` (and a legacy
// link to it) by itself, and that decision is one module. Its presence at a
// HEAD is exact for every history that carries the code — a fork or an import
// that rewrote the commits included — where an ancestry test against a
// hardcoded SHA is exact only for this repo's own history. If the module ever
// moves, the test beside this file fails until the path follows it.
//
// Every checkout, not only those that built: a worktree's `./equin` verbs, its
// guard hooks, its backend (served from its source tree) and a relaunched
// agent all run its source as it is now, built or not — so the deploy
// registry, which only knows the last build, would undercount.

/** The module that decides the data root by what is installed (`paths/core`'s data-root layout). */
export const LAYOUT_RULE_MODULE =
  "plugins/infra/plugins/paths/core/internal/data-root-layout.ts";

/**
 * Every checkout of the repo at `repoRoot` whose HEAD lacks the layout rule.
 * A bare entry and a prunable one (its directory is gone) run nothing.
 */
export async function staleCheckouts(
  repoRoot: string,
): Promise<StaleCheckout[]> {
  const entries = (await listWorktreeEntries(repoRoot)).filter(
    (e): e is WorktreeEntry & { head: string } =>
      e.head !== null && !e.prunable,
  );
  const heads = [...new Set(entries.map((e) => e.head))];
  if (heads.length === 0) return [];
  // One process for every HEAD: the worktrees share one object store.
  const { stdout } = await spawnExpectOk(
    [GIT, "-C", repoRoot, "cat-file", "--batch-check"],
    {
      stdin: heads.map((h) => `${h}:${LAYOUT_RULE_MODULE}\n`).join(""),
      timeoutMs: 60_000,
    },
  );
  const lacking = headsLacking(heads, stdout);
  return entries
    .filter((e) => lacking.has(e.head))
    .map((e) => ({ path: e.path, head: e.head }));
}

/**
 * The heads `git cat-file --batch-check` answered `missing` for — one output
 * line per input line, in order. Anything but a blob or `missing` is not an
 * answer to the question asked, so it throws rather than counting either way.
 */
export function headsLacking(
  heads: readonly string[],
  stdout: string,
): Set<string> {
  const lines = stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== heads.length) {
    throw new Error(
      `git cat-file --batch-check answered ${lines.length} lines for ${heads.length} heads:\n${stdout}`,
    );
  }
  const lacking = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const head = heads[i]!;
    if (line.endsWith(" missing")) lacking.add(head);
    else if (!/^[0-9a-f]+ blob \d+$/.test(line)) {
      throw new Error(
        `git cat-file --batch-check: unexpected answer for ${head}:${LAYOUT_RULE_MODULE}: ${line}`,
      );
    }
  }
  return lacking;
}
