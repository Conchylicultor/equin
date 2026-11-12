import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import { attemptBranchName } from "@plugins/infra/plugins/worktree/core";
import { promoFilmWorkspaceDir } from "../../data-dirs";
import { FILM_CLOCK_FILE, type FilmClock } from "../../core";
import {
  EXTRA_PIECES,
  extraPieceBytes,
  PIECE,
  pieceMidiBytes,
  piecePage1Bytes,
  pieceScoreBytes,
} from "./story/piece";
import type { FilmRun } from "./story/tasks";

/** A run's folder — the attempt's worktree path, named by its attempt id as an agent's worktree is. */
export const runWorkspace = (run: FilmRun): string =>
  promoFilmWorkspaceDir.file(run.attemptId);

/**
 * The film's stand-in home folder (`host-account`'s `home-folder` config): what
 * every app shows and opens as Home, so the machine's real home is never read.
 */
export const standInHomeFolder = (): string =>
  promoFilmWorkspaceDir.file("home");

/** The user's own Piano folder, `~/Music/Piano` — the Files app's start folder in the film. */
export const pianoFolder = (): string =>
  join(standInHomeFolder(), "Music", "Piano");

/** Small plain files for the rest of the home folder, in a person's voice. */
const HOME_TEXTS: readonly { path: string; daysAgo: number; text: string }[] = [
  {
    path: "Downloads/train-tickets.txt",
    daysAgo: 4,
    text: "Train to Lyon, Friday 07:42, coach 5, seats 31 and 32.\nPlatform is announced 20 minutes before.\n",
  },
  {
    path: "Downloads/chair-assembly-notes.txt",
    daysAgo: 16,
    text: "Piano stool: the four long screws go in last. Tighten them only once everything is in place.\n",
  },
  {
    path: "Documents/to-do.txt",
    daysAgo: 2,
    text: "- Call the piano tuner\n- Print the recital program\n- Renew the library card\n",
  },
  {
    path: "Documents/holiday-ideas.txt",
    daysAgo: 30,
    text: "Somewhere with mountains and a quiet afternoon. Maybe the Norwegian fjords in June.\n",
  },
];

/**
 * The stand-in home folder's contents: `Music/Piano` (the Piano folder) beside
 * a modest `Downloads` and `Documents`. Written after the workspace reset.
 */
export async function writeHomeFolder(
  /** The film's now (film-clock): modified times are counted back from it. */
  now: number,
): Promise<string> {
  const home = standInHomeFolder();
  await mkdir(home, { recursive: true });
  await writePianoFolder(now);
  for (const t of HOME_TEXTS) {
    const [path] = await writeFiles(home, [[t.path, t.text]]);
    const at = new Date(now - t.daysAgo * DAY_MS);
    await utimes(path!, at, at);
  }
  // Folders last: writing a file stamped them with now.
  for (const [sub, daysAgo] of [
    ["Downloads", 4],
    ["Documents", 2],
    ["Music", 1],
  ] as const) {
    const at = new Date(now - daysAgo * DAY_MS);
    await utimes(join(home, sub), at, at);
  }
  return home;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The film's instant, left beside the workspace (`FILM_CLOCK_FILE`) for the
 * recording to pin every page's calendar to. Written after the workspace
 * reset, so it is always this seed's.
 */
export async function writeFilmClock(clock: FilmClock): Promise<void> {
  await mkdir(promoFilmWorkspaceDir.path, { recursive: true });
  await writeFile(
    promoFilmWorkspaceDir.file(FILM_CLOCK_FILE),
    JSON.stringify(clock),
  );
}

/** The notes the user keeps next to their scores, in their own words. */
const PIANO_TEXTS: readonly { path: string; daysAgo: number; text: string }[] =
  [
    {
      path: "recital-program.txt",
      daysAgo: 12,
      text: [
        "Recital, Saturday 21 November, 15:00",
        "",
        "1. Prelude in C major, BWV 846 (Bach)",
        "2. Gymnopedie No. 1 (Satie)",
        "3. Nocturne in E-flat major, Op. 9 No. 2 (Chopin)",
        "",
        "Arrive at 14:15 to warm up on the hall's piano.",
        "",
      ].join("\n"),
    },
    {
      path: "lessons/2026-10-13.txt",
      daysAgo: 21,
      text: [
        "Lesson 13 Oct",
        "- Nocturne: the left hand is too loud in bars 5 to 8. The melody has to sing.",
        "- Pedal: change on every bar line, not before.",
        "- Bach prelude is good. Next time play it from memory.",
        "",
      ].join("\n"),
    },
    {
      path: "lessons/2026-10-27.txt",
      daysAgo: 7,
      text: [
        "Lesson 27 Oct",
        "- Nocturne: much better. Slow down at the cadenza and wait before the last note.",
        "- Homework: scales in D major, hands together, 80 bpm.",
        "- Next piece after the recital: something joyful. She suggested Grieg.",
        "",
      ].join("\n"),
    },
  ];

/**
 * The user's Piano folder, as someone keeps one: `scores/` (PDFs, one as an
 * image), `music/` (MIDI), `lessons/` (their notes after each lesson) and the
 * recital program — a modest set, with modified times spread over the past
 * months. Real Mutopia public-domain files, pinned.
 */
export async function writePianoFolder(now: number): Promise<string> {
  const dir = pianoFolder();
  const files: readonly [string, string | Uint8Array, number][] = [
    [PIECE.score.path, await pieceScoreBytes(), 1],
    [PIECE.page1.path, await piecePage1Bytes(), 1],
    [PIECE.midi.path, await pieceMidiBytes(), 1],
    ...(await Promise.all(
      EXTRA_PIECES.map(async (p): Promise<[string, Uint8Array, number]> => [
        p.path,
        await extraPieceBytes(p),
        p.daysAgo,
      ]),
    )),
    ...PIANO_TEXTS.map((t): [string, string, number] => [
      t.path,
      t.text,
      t.daysAgo,
    ]),
  ];
  for (const [rel, content, daysAgo] of files) {
    const [path] = await writeFiles(dir, [[rel, content]]);
    const at = new Date(now - daysAgo * DAY_MS);
    await utimes(path!, at, at);
  }
  // Folders last: writing a file stamped them with now.
  for (const [sub, daysAgo] of [
    ["scores", 1],
    ["music", 1],
    ["lessons", 7],
  ] as const) {
    const at = new Date(now - daysAgo * DAY_MS);
    await utimes(join(dir, sub), at, at);
  }
  return dir;
}

/**
 * Rewrite the film's workspace from scratch: per run, a git checkout of THIS
 * repository on the run's own branch, rooted at `main`'s tip — as an agent's
 * worktree is — so everything that measures an attempt from git (its edited
 * files, its standing against `main`: `tasks/attempt-work`'s merge-base and
 * ahead/behind against the live `main`) reads a real attempt. The Grieg run's
 * agent is mid-conversation, so its files are uncommitted changes on its
 * branch: the score (and its first page as an image) and the MIDI its
 * transcript fetches (the committed public-domain fixtures), each in its own
 * folder. Every other run's checkout is clean: its work is in the app (a page,
 * a prototype), not in the repository.
 *
 * The reset is the `rm`: a checkout is a self-contained clone (below), never
 * registered in this repository, so nothing is left to prune.
 */
export async function writeWorkspace(
  runs: readonly FilmRun[],
  grieg: FilmRun,
): Promise<string[]> {
  await rm(promoFilmWorkspaceDir.path, { recursive: true, force: true });
  const repo = await commonGitDir();
  for (const run of runs) await writeRunCheckout(run, repo);
  return writeFiles(runWorkspace(grieg), [
    [PIECE.score.path, await pieceScoreBytes()],
    [PIECE.page1.path, await piecePage1Bytes()],
    [PIECE.midi.path, await pieceMidiBytes()],
  ]);
}

/**
 * One run's checkout at `runWorkspace(run)` (absent): this repository's
 * history, on the attempt's branch (`claude-web/<attemptId>`, the name
 * `setupWorktree` gives it) at `main`'s tip, with no file of the tree written.
 *
 * Not a `git worktree` (`infra/worktree`'s `addCheckout`): that writes the
 * whole tree (~23k files) per run, twenty runs a seed, and registers each in
 * this repository's `.git/worktrees`, where the reaper and the namespace passes
 * see it. Instead a `--shared` clone — its objects are this repository's
 * (`objects/info/alternates`: the history, `main` as it moves included, at
 * ~3 MB of index per run) — with a sparse checkout matching nothing, so the
 * tree is in the index and none of it on disk (`git status` reads clean). Its
 * own `main` is the one it was cloned at; the remote is dropped, so it names
 * nothing to push to.
 */
export async function writeRunCheckout(
  run: FilmRun,
  /** This repository's common git dir (`commonGitDir()`). */
  repo: string,
): Promise<void> {
  const dir = runWorkspace(run);
  await mkdir(dirname(dir), { recursive: true });
  await git(
    dirname(dir),
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    "--single-branch",
    "--branch",
    "main",
    "--no-tags",
    repo,
    dir,
  );
  await git(dir, "remote", "remove", "origin");
  await git(dir, "sparse-checkout", "set", "--no-cone", NO_PATH);
  await git(dir, "switch", "--quiet", "-c", attemptBranchName(run.attemptId));
  await git(dir, "read-tree", "-mu", "HEAD");
}

/** A sparse-checkout pattern no path of the repository matches. */
const NO_PATH = "/.promo-film-checkout-holds-no-file";

/** This repository's common git dir — the one every checkout of it shares. */
export async function commonGitDir(): Promise<string> {
  const { stdout } = await spawnExpectOk(
    [
      GIT,
      "-C",
      REPO_ROOT,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { timeoutMs: 30_000 },
  );
  return stdout.trim();
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

/**
 * One git command in `dir` — loud on failure. Anything it records carries no
 * person's name: the author is the app itself.
 */
async function git(dir: string, ...args: string[]): Promise<void> {
  const result = await spawnCaptured(
    [
      GIT,
      "-c",
      "user.name=equin",
      "-c",
      "user.email=noreply@equin.ai",
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
