import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  copyIndex,
  publishRefreshedIndex,
  type IndexPublish,
} from "@plugins/infra/plugins/git/plugins/private-index/core";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  joinAppPath,
  appPathParent,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// A status is a read: well past a fresh checkout's ~1 s walk, short of hiding a wedge.
const PRIME_TIMEOUT_MS = 120_000;

// Asked for on the call, not left to the repo's config (a clone that never
// set it), as `computeTreeHash` does.
const WITH_UNTRACKED_CACHE = ["-c", "core.untrackedCache=true"];

/** What this primer publishes, or why it did not. */
export type UntrackedCachePrime = IndexPublish;

async function git(
  wtPath: string,
  args: string[],
  opts: { indexFile?: string; signal?: AbortSignal },
): Promise<string> {
  // Never an inherited GIT_INDEX_FILE: the index read here is the checkout's
  // own, or the private copy named.
  const { GIT_INDEX_FILE: _inherited, ...env } = process.env;
  const argv = [GIT, "-C", wtPath, ...args];
  const r = await spawnCaptured(argv, {
    tier: "background",
    timeoutMs: PRIME_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.indexFile
      ? {
          env: { ...env, GIT_INDEX_FILE: opts.indexFile },
          privateIndexWrites: true,
        }
      : { env }),
  });
  if (r.timedOut || r.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} ${r.timedOut ? `did not finish within ${PRIME_TIMEOUT_MS} ms` : `failed (exit ${r.exitCode})`}: ` +
        `${r.stderr.trim() || "<no stderr>"}`,
    );
  }
  return r.stdout.trim();
}

/**
 * Fill a NEW checkout's untracked cache — the `UNTR` extension of its index,
 * every directory's listing keyed by the directory's mtime.
 *
 * Why: no git read of ours may write a checkout's index (spawn's child-env sets
 * `GIT_OPTIONAL_LOCKS=0` on every child), so a checkout's untracked cache is
 * created EMPTY (by its add, or the claim's switch) and stays empty until its
 * first `./equin check` publishes one (`computeTreeHash`). Until then every
 * `git status` in it — the edited-files pass runs one per change while its
 * conversation is open — re-reads all ~9.6k directories of the tree: 0.6–2.5 s
 * on a busy host (opendir 9,582), against 0.13–0.37 s for a checkout whose
 * cache is filled (opendir 0). Filled, a status `stat`s the directories and
 * re-reads only those whose mtime moved; a later commit, switch or rebase keeps
 * the cache and invalidates only the directories it wrote.
 *
 * How — `infra/git/private-index`, the protocol `computeTreeHash`'s publish
 * uses too: `git status` on a PRIVATE copy of the index (allowed to write
 * it: `privateIndexWrites`), then that copy replaces the real index by
 * compare-and-swap under git's own `index.lock`, taken `wx`, held for one stat
 * and one rename — only while nobody wrote the real index since it was copied,
 * and not at all while a git writer holds the lock. The copy differs from the
 * real index in stat data and the untracked cache only (status never stages).
 *
 * When: once the checkout is at its final path and installed. Not on a spare:
 * the cache names the checkout's location, so a claim's move drops it.
 */
export async function primeUntrackedCache(
  wtPath: string,
  signal?: AbortSignal,
): Promise<UntrackedCachePrime> {
  // This checkout's own index: the one path this primer claims.
  const realIndex = asAppPath(
    await git(
      wtPath,
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      { signal },
    ),
  );
  const seen = await stat(realIndex, { bigint: true });
  const scratch = joinAppPath(
    appPathParent(realIndex),
    `${realIndex.slice(realIndex.lastIndexOf("/") + 1)}.untracked-prime-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    // WITH the real index's mtime (racy git — see `copyIndex`).
    await copyIndex(realIndex, seen, scratch);
    await git(
      wtPath,
      [
        ...WITH_UNTRACKED_CACHE,
        "status",
        "--porcelain",
        // The mode the cache is kept for — what its readers ask (the
        // edited-files pass, the tree hash). A cache made for another mode is
        // not used by them.
        "--untracked-files=normal",
      ],
      { indexFile: scratch, signal },
    );
    return await publishRefreshedIndex(realIndex, scratch, seen);
  } finally {
    await rm(scratch, { force: true });
  }
}
