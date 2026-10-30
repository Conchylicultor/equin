import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { promoFilmWorkspaceDir } from "../../data-dirs";
import { minuetMidiBytes, minuetScript } from "./story/minuet";
import { PRACTICE_FILES, PRACTICE_NOTES } from "./story/transcripts";
import type { FilmRun } from "./story/tasks";

/** A run's folder — the attempt's worktree path, named by its attempt id as an agent's worktree is. */
export const runWorkspace = (run: FilmRun): string =>
  promoFilmWorkspaceDir.file(run.attemptId);

/** What every run's checkout holds on `main` before its agent starts. */
const BASE_FILES: readonly [string, string][] = [
  [
    "README.md",
    "# Recital\n\nPractice material for the spring piano recital.\n",
  ],
];

/**
 * Rewrite the film's workspace from scratch: per run, a git checkout as an
 * agent's worktree is — `main` with one base commit, the run's own branch
 * checked out — so everything that measures an attempt from git (its edited
 * files, its standing against `main`) reads a real repository. The practice
 * run's agent is mid-conversation, so its files are uncommitted changes on
 * its branch: the script and the notes its transcript writes, and the MIDI
 * file running that script makes (generated from the same notes).
 */
export async function writeWorkspace(
  runs: readonly FilmRun[],
  practice: FilmRun,
): Promise<string[]> {
  await rm(promoFilmWorkspaceDir.path, { recursive: true, force: true });
  for (const run of runs) {
    const dir = runWorkspace(run);
    await writeFiles(dir, BASE_FILES);
    await git(dir, "init", "--quiet", "--initial-branch=main");
    await git(dir, "add", "--all");
    await git(dir, "commit", "--quiet", "--message", "Recital practice folder");
    await git(dir, "checkout", "--quiet", "-b", run.attemptId);
  }
  return writeFiles(runWorkspace(practice), [
    [PRACTICE_FILES.script, minuetScript()],
    [PRACTICE_FILES.notes, PRACTICE_NOTES],
    [PRACTICE_FILES.midi, minuetMidiBytes()],
  ]);
}

async function writeFiles(
  dir: string,
  files: readonly [string, string | Uint8Array][],
): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of files) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    written.push(path);
  }
  return written;
}

/** One git command in `dir`, as the film's made-up author — loud on failure. */
async function git(dir: string, ...args: string[]): Promise<void> {
  const result = await spawnCaptured(
    [
      "git",
      "-c",
      "user.name=Etienne",
      "-c",
      "user.email=etienne@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: dir, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `[promo-film seed] git ${args.join(" ")} in ${dir} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
}
