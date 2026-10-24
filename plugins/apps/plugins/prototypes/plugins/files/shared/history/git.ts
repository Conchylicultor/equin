import {
  spawnCaptured,
  spawnExpectOk,
  type SpawnResult,
} from "@plugins/infra/plugins/spawn/core";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";

// The one way this plugin runs git: hermetic, against ONE prototype's private
// history repo, with the prototype folder as its work tree.
//
// Hermetic because the repo is the store's, not the user's: nothing in their
// git config (a global hook, commit signing, `init.templateDir`, an alias, an
// `autocrlf`) may change what a commit contains or whether it succeeds. So the
// environment is REPLACED rather than inherited — no config file is read, no
// `GIT_DIR` / `GIT_INDEX_FILE` leaking in from whoever started the process can
// point a command at a different repo — and the identity is fixed.
//
// Spelled `git` rather than taking `GIT` from `infra/paths/server`: this module
// runs in the CLI with no backend, and `shared/` may not import a `server`
// barrel. `spawn/core`'s own git reads (`getWorktreeRoot`) spell it the same
// way — the binary comes off `PATH` either way.

const GIT_BIN = "git";

/**
 * Wedge-breaker, not latency police: every command here touches a handful of
 * small files and samples in milliseconds. Sized for a starved box, like
 * `spawn/core`'s git reads.
 */
const GIT_TIMEOUT_MS = 60_000;

/** Who every version is committed as — the store, never the user. */
const STORE_IDENTITY = {
  name: "equin prototypes",
  email: "prototypes@singularity.invalid",
};

function hermeticEnv(): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: HOME_DIR,
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // A read (`status`) must never take the index lock a concurrent write
    // (`add`, `commit`) is about to need — only reads are unlocked, so the
    // history's own flock is what serializes the writes.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: STORE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: STORE_IDENTITY.email,
    GIT_COMMITTER_NAME: STORE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: STORE_IDENTITY.email,
  };
}

/** Config every command runs under, on top of the empty environment. */
const PINNED_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
];

/** `git init` a bare repo at `repo`: no template (no hooks, no sample files). */
export async function initBareRepo(repo: string): Promise<void> {
  await runOk([
    GIT_BIN,
    ...PINNED_CONFIG,
    "init",
    "--bare",
    "--quiet",
    "--template=",
    "--initial-branch=main",
    repo,
  ]);
}

/** Git commands against one prototype's history repo. */
export interface HistoryGit {
  /** Run; a non-zero exit throws `SpawnFailedError`. */
  run(args: string[], opts?: { stdin?: string }): Promise<SpawnResult>;
  /** Run; the exit code is the caller's to read (`diff --quiet`, `rev-parse --verify`). */
  probe(args: string[]): Promise<SpawnResult>;
}

/** Bind git to `repo` (the bare history repo) with `workTree` (the prototype folder). */
export function historyGit(repo: string, workTree: string): HistoryGit {
  const argv = (args: string[]): string[] => [
    GIT_BIN,
    `--git-dir=${repo}`,
    `--work-tree=${workTree}`,
    ...PINNED_CONFIG,
    ...args,
  ];
  return {
    run: (args, opts) => runOk(argv(args), opts?.stdin),
    probe: (args) =>
      spawnCaptured(argv(args), {
        env: hermeticEnv(),
        timeoutMs: GIT_TIMEOUT_MS,
      }),
  };
}

function runOk(argv: string[], stdin?: string): Promise<SpawnResult> {
  return spawnExpectOk(argv, {
    env: hermeticEnv(),
    timeoutMs: GIT_TIMEOUT_MS,
    ...(stdin === undefined ? {} : { stdin }),
  });
}
