import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  copyIndex,
  publishRefreshedIndex,
  type IndexPublish,
} from "@plugins/infra/plugins/git/plugins/private-index/core";
import { readFile, stat } from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  joinAppPath,
  appPathParent,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { countRacyEntries } from "../../core";

// A status is a read: well past a fresh checkout's ~1 s walk, short of hiding a wedge.
const REFRESH_TIMEOUT_MS = 120_000;

// Asked for on the call, not left to the repo's config (a clone that never
// set it), as `computeTreeHash` does.
const WITH_UNTRACKED_CACHE = ["-c", "core.untrackedCache=true"];

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
    timeoutMs: REFRESH_TIMEOUT_MS,
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
      `${argv.join(" ")} ${r.timedOut ? `did not finish within ${REFRESH_TIMEOUT_MS} ms` : `failed (exit ${r.exitCode})`}: ` +
        `${r.stderr.trim() || "<no stderr>"}`,
    );
  }
  return r.stdout.trim();
}

/** This checkout's own index, as git names it. */
async function indexPathOf(
  wtPath: string,
  signal?: AbortSignal,
): Promise<AppPath> {
  return asAppPath(
    await git(
      wtPath,
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      { signal },
    ),
  );
}

/**
 * Make a checkout's index vouch for its files again: refresh its stat data
 * (racily-clean entries re-checked by content once, then trusted) and fill its
 * untracked cache (`UNTR`, every directory's listing keyed by its mtime).
 *
 * Why: no git read of ours may write a checkout's index (spawn's child-env sets
 * `GIT_OPTIONAL_LOCKS=0` on every child), so whatever left the index unable to
 * vouch for the tree stays that way until the next real index write:
 *
 * - its untracked cache, created EMPTY (by its add, or the claim's switch) —
 *   every `git status` re-reads all ~9.6k directories: 0.6–2.5 s on a busy
 *   host, against 0.13–0.37 s filled (opendir 0);
 * - its racily-clean entries ({@link countRacyEntries}) — every `git status`
 *   and `git diff <rev>` re-reads and hashes each of those files (6,857 in one
 *   checkout: 0.6 s warm, 8 s cold, per read, for a branch with no change).
 *
 * How — `infra/git/private-index`, the protocol `computeTreeHash`'s publish
 * uses too: `git status` on a PRIVATE copy of the index (allowed to write
 * it: `privateIndexWrites`), then that copy replaces the real index by
 * compare-and-swap under git's own `index.lock`, taken `wx`, held for one stat
 * and one rename — only while nobody wrote the real index since it was copied,
 * and not at all while a git writer holds the lock. The copy differs from the
 * real index in stat data and the untracked cache only (status never stages).
 *
 * The untracked cache names the checkout's location: a spare's is dropped by
 * the claim's move, so refresh a checkout at its final path.
 */
export async function refreshCheckoutIndex(
  wtPath: string,
  signal?: AbortSignal,
): Promise<IndexPublish> {
  const realIndex = await indexPathOf(wtPath, signal);
  const seen = await stat(realIndex, { bigint: true });
  const scratch = joinAppPath(
    appPathParent(realIndex),
    `${realIndex.slice(realIndex.lastIndexOf("/") + 1)}.refresh-${process.pid}-${randomBytes(4).toString("hex")}`,
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

/** What {@link refreshIndexIfRacy} found, and did. */
export type IndexTrust =
  /** No racily-clean entry (or no index yet): nothing to do. */
  | { kind: "trusted"; entries: number }
  /** `racy` entries could not be trusted; the refresh's publish outcome. */
  | { kind: "refreshed"; entries: number; racy: number; publish: IndexPublish };

/**
 * Refresh `wtPath`'s index ({@link refreshCheckoutIndex}) when it holds
 * racily-clean entries, and only then — the check is one read of the index
 * file, no git spawn, so it can run on every index write a watch hears.
 *
 * A refresh written in the same whole second as the files it vouches for
 * would leave them racy again (git smudges them as it writes), so when the
 * index is that fresh this waits for the next second first — a one-shot
 * delay set by git's whole-second rule, not a poll.
 */
export async function refreshIndexIfRacy(wtPath: string): Promise<IndexTrust> {
  const realIndex = await indexPathOf(wtPath);
  let bytes: Uint8Array;
  let mtimeMs: number;
  try {
    const st = await stat(realIndex);
    mtimeMs = st.mtimeMs;
    bytes = await readFile(realIndex);
  } catch (err) {
    // A checkout whose index git has not written yet: nothing to trust.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "trusted", entries: 0 };
    }
    throw err;
  }
  const mtimeSec = Math.floor(mtimeMs / 1000);
  const { entries, racy } = countRacyEntries(bytes, mtimeSec);
  if (racy === 0) return { kind: "trusted", entries };
  const nextSecondMs = (mtimeSec + 1) * 1000 - Date.now();
  if (nextSecondMs > 0) await Bun.sleep(nextSecondMs + 5);
  return {
    kind: "refreshed",
    entries,
    racy,
    publish: await refreshCheckoutIndex(wtPath),
  };
}
