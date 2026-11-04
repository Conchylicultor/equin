import { createHash } from "node:crypto";
import { lstat } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import {
  GitError,
  parseDiffNameStatusZ,
  runGit,
  tryRunGit,
} from "@plugins/primitives/plugins/commit-list/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import type { GitStatus } from "../../shared/resources";
import { assembleStatus, parsePorcelainV2Z } from "./parse-status";

/**
 * One read of the whole checkout, bounded by what changed: untracked and
 * ignored folders come back collapsed. `--ignored=matching` rather than
 * `traditional`: the same collapsed `node_modules/`, without walking every
 * ignored folder to prove all of its contents ignored (measured 3–4× slower on
 * this repo) — a folder whose files are each ignored by a file pattern lists
 * those files instead.
 */
const STATUS_ARGS = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--untracked-files=normal",
  "--ignored=matching",
];

const MAIN = "refs/heads/main";

/** `main`'s commit, or `null` when the checkout has no `main` branch. */
async function readMain(root: string): Promise<string | null> {
  const res = await tryRunGit(
    ["rev-parse", "--verify", "--quiet", `${MAIN}^{commit}`],
    root,
  );
  return res.ok ? res.stdout.trim() : null;
}

/** `merge-base main HEAD`; `null` without a `main` or a common ancestor (exit 1). */
async function readMergeBase(root: string): Promise<string | null> {
  if ((await readMain(root)) === null) return null;
  const args = ["merge-base", MAIN, "HEAD"];
  const res = await tryRunGit(args, root);
  if (res.ok) return res.stdout.trim();
  if (res.exitCode === 1) return null;
  throw new GitError({
    args,
    cwd: root,
    exitCode: res.exitCode,
    stderr: res.stderr,
  });
}

/**
 * The value's inputs, fingerprinted without the diff: the porcelain read
 * itself (HEAD, every status vs HEAD, untracked and ignored), `main`'s commit
 * (which with HEAD fixes the merge-base), and each path changed vs HEAD's
 * `lstat` — a dirty file can come to match or leave main's version while its
 * status vs HEAD stays `M`. Ungated, like edited-files' signature.
 */
async function gitStatusSignature(root: string): Promise<string> {
  const [statusZ, main] = await Promise.all([
    runGit(STATUS_ARGS, root),
    readMain(root),
  ]);
  const hash = createHash("sha256")
    .update(statusZ)
    .update(`\0${main ?? ""}\0`);
  const dirty = [...parsePorcelainV2Z(statusZ).vsHead.keys()];
  const stats = await Promise.all(
    dirty.map(async (path) => {
      try {
        const st = await lstat(join(root, path));
        return `${path}\0${st.mtimeMs}\0${st.size}`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return `${path}\0gone`;
      }
    }),
  );
  for (const s of stats) hash.update(s).update("\0");
  return hash.digest("hex");
}

async function computeGitStatus(root: string): Promise<GitStatus> {
  return withHeavyReadSlot(async () => {
    const porcelain = parsePorcelainV2Z(await runGit(STATUS_ARGS, root));
    const mergeBase =
      porcelain.head === null ? null : await readMergeBase(root);
    const vsMain =
      mergeBase === null
        ? []
        : parseDiffNameStatusZ(
            await runGit(
              ["diff", "-M", "-z", "--name-status", mergeBase],
              root,
            ),
          );
    return assembleStatus(porcelain, mergeBase, vsMain);
  });
}

/** The status per checkout root, behind its content signature. */
export const gitStatusMemo = createSignedMemo<GitStatus>({
  name: "file-explorer.git-status",
  signature: gitStatusSignature,
  compute: computeGitStatus,
});
