import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { readFile, stat } from "@plugins/packages/plugins/timed-fs/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { getGitHygiene, type GitHygiene } from "./safety";

// Why a dirty checkout is not re-walked every sweep.
//
// `git status` over a checkout lstat's all ~22k tracked files. The hourly sweep
// asks it of every finished checkout past 72 h — and a dirty one stays a
// candidate until the 90-day floor, so the same unchanged trees were walked
// again on every run (~43 of them, 40–80 runs a day). Nobody touches them.
//
// A dirty verdict comes with its first changed path. That path keeps the tree
// dirty for as long as the path itself, the index and HEAD all read as they did:
// a modified file whose bytes have not moved still differs from an unmoved
// index; an untracked file still there is still untracked; a deleted one still
// gone is still deleted. So the sweep re-checks three small things instead of
// the tree, and walks it again the moment one of them moves — a real change
// signal, not an age.
//
// Only "dirty" is ever witnessed. A wrong witness can only claim dirty for a
// tree that has meanwhile become clean, which DEFERS a reap and never causes
// one; a clean verdict is not cached at all (it makes the checkout a target).

/** The state of one file the witness compares: absent, or its mtime and size. */
const FileState = z.union([
  z.null(),
  z.object({ mtimeMs: z.number(), size: z.number() }),
]);
type FileState = z.infer<typeof FileState>;

const Witness = z.object({
  path: z.string(),
  pathState: FileState,
  index: FileState,
  // HEAD's own text, plus the loose ref it names when there is one ("" when the
  // ref is packed): a moved branch changes what the index is compared against.
  head: z.string(),
});
type Witness = z.infer<typeof Witness>;

// "Not there": the path itself is missing, or a parent of it is no longer a
// directory. Any other error is real and thrown.
const isAbsent = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

async function fileState(path: string): Promise<FileState> {
  try {
    const st = await stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if (isAbsent(err)) return null;
    throw err;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isAbsent(err)) return null;
    throw err;
  }
}

// The checkout's git dir, from its `.git` file (`gitdir: <path>`), and the
// repository's common dir (where refs live). `null` when the checkout's `.git`
// is not a linked-worktree pointer — then there is no witness to take.
async function gitDirsOf(
  wtPath: string,
): Promise<{ gitDir: string; commonDir: string } | null> {
  let dotGit: string | null;
  try {
    dotGit = await readOptional(join(wtPath, ".git"));
  } catch (err) {
    // A `.git` DIRECTORY: a full clone, not a linked worktree — no witness.
    if ((err as NodeJS.ErrnoException).code === "EISDIR") return null;
    throw err;
  }
  const match = dotGit?.match(/^gitdir: (.+)$/m);
  if (!match) return null;
  const gitDir = resolve(wtPath, match[1]!.trim());
  const common = (await readOptional(join(gitDir, "commondir")))?.trim();
  const commonDir =
    common === undefined
      ? gitDir
      : isAbsolute(common)
        ? common
        : resolve(gitDir, common);
  return { gitDir, commonDir };
}

async function headState(gitDir: string, commonDir: string): Promise<string> {
  const head = (await readOptional(join(gitDir, "HEAD"))) ?? "";
  const ref = head.match(/^ref: (.+)$/m)?.[1]?.trim();
  if (ref === undefined) return head;
  const loose = await readOptional(join(commonDir, ref));
  return `${head}\n${loose ?? ""}`;
}

// The witness as it reads on disk right now, for `path` in `wtPath`.
async function current(wtPath: string, path: string): Promise<Witness | null> {
  const dirs = await gitDirsOf(wtPath);
  if (dirs === null) return null;
  return {
    path,
    pathState: await fileState(join(wtPath, path)),
    index: await fileState(join(dirs.gitDir, "index")),
    head: await headState(dirs.gitDir, dirs.commonDir),
  };
}

async function readWitness(ns: Namespace): Promise<Witness | null> {
  const text = await readOptional(worktreeArtifacts.hygieneWitness(ns));
  if (text === null) return null;
  // A witness this code cannot read proves nothing: re-probe (and rewrite it).
  // Writes are atomic (below), so this is a file from another version, not a
  // torn one.
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  const parsed = Witness.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const sameState = (a: FileState, b: FileState): boolean =>
  a === null || b === null
    ? a === b
    : a.mtimeMs === b.mtimeMs && a.size === b.size;

/**
 * The checkout's hygiene for the sweep: "still dirty" from its witness when
 * that still holds, else a real `git status` — whose dirty verdict leaves a
 * fresh witness. `probed` says which, for the sweep's log.
 */
export async function sweepHygiene(
  ns: Namespace,
  wtPath: string,
): Promise<{ hygiene: GitHygiene; probed: boolean }> {
  const stored = await readWitness(ns);
  if (stored !== null) {
    const now = await current(wtPath, stored.path);
    if (
      now !== null &&
      sameState(now.pathState, stored.pathState) &&
      sameState(now.index, stored.index) &&
      now.head === stored.head
    ) {
      return { hygiene: { isDirty: true }, probed: false };
    }
  }

  const hygiene = await getGitHygiene(wtPath, { background: true });
  const file = worktreeArtifacts.hygieneWitness(ns);
  const witness =
    hygiene.isDirty && hygiene.dirtyPath !== undefined
      ? await current(wtPath, hygiene.dirtyPath)
      : null;
  if (witness === null) {
    await rm(file, { force: true });
  } else {
    // Atomic: a sweep killed mid-write leaves the old witness or the new one.
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(witness)}\n`);
    await rename(tmp, file);
  }
  return { hygiene, probed: true };
}
