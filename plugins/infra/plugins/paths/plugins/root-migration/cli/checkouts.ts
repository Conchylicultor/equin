import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { listWorktreeEntries } from "@plugins/infra/plugins/worktree/server";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
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

/**
 * The module that decides the data root by what is installed, at every path it
 * has had — current first. A HEAD carrying it at ANY of them has the rule: it
 * moved from `paths/core` into the `data-root-layout` leaf, and a checkout
 * from before the move has it all the same.
 */
export const LAYOUT_RULE_MODULES = [
  "plugins/infra/plugins/paths/plugins/data-root-layout/core/internal/data-root-layout.ts",
  "plugins/infra/plugins/paths/core/internal/data-root-layout.ts",
] as const;

/** One `cat-file --batch-check` query per (head, module path), heads outer. */
function layoutQueries(heads: readonly string[]): string[] {
  return heads.flatMap((h) => LAYOUT_RULE_MODULES.map((m) => `${h}:${m}`));
}

/**
 * Every checkout of the repo at `repoRoot` whose HEAD lacks the layout rule.
 * An entry whose HEAD is not written yet and a prunable one (its directory is
 * gone) run nothing.
 */
export async function staleCheckouts(
  repoRoot: AppPath,
): Promise<StaleCheckout[]> {
  // A HEAD as git names it: a symbolic ref goes to `cat-file` as the ref
  // itself (one shared ref store), a detached one as its commit.
  const entries = (await listWorktreeEntries(repoRoot)).flatMap((e) =>
    e.head === null || e.prunable
      ? []
      : [
          {
            path: e.path,
            head: e.head.kind === "branch" ? e.head.ref : e.head.commit,
          },
        ],
  );
  const heads = [...new Set(entries.map((e) => e.head))];
  if (heads.length === 0) return [];
  // One process for every HEAD: the worktrees share one object store.
  const { stdout } = await spawnExpectOk(
    [GIT, "-C", repoRoot, "cat-file", "--batch-check"],
    {
      stdin: layoutQueries(heads)
        .map((q) => `${q}\n`)
        .join(""),
      timeoutMs: 60_000,
    },
  );
  const lacking = headsLacking(heads, stdout);
  return entries
    .filter((e) => lacking.has(e.head))
    .map((e) => ({ path: e.path, head: e.head }));
}

/**
 * The heads `git cat-file --batch-check` answered `missing` for at every
 * {@link LAYOUT_RULE_MODULES} path — one output line per query of
 * `layoutQueries(heads)`, in order. Anything but a blob or `missing` is not an
 * answer to the question asked, so it throws rather than counting either way.
 */
export function headsLacking(
  heads: readonly string[],
  stdout: string,
): Set<string> {
  const queries = layoutQueries(heads);
  const lines = stdout.split("\n").filter((l) => l !== "");
  if (lines.length !== queries.length) {
    throw new Error(
      `git cat-file --batch-check answered ${lines.length} lines for ${queries.length} queries:\n${stdout}`,
    );
  }
  const found = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const head = heads[Math.floor(i / LAYOUT_RULE_MODULES.length)]!;
    if (/^[0-9a-f]+ blob \d+$/.test(line)) found.add(head);
    else if (!line.endsWith(" missing")) {
      throw new Error(
        `git cat-file --batch-check: unexpected answer for ${queries[i]}: ${line}`,
      );
    }
  }
  return new Set(heads.filter((h) => !found.has(h)));
}
