import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ShellCall } from "./parse-shell";
import { CLI_NAMES } from "@plugins/framework/plugins/cli/core";

/**
 * Which repository a `git` call acts on, and what it runs there.
 *
 * `repo` is `"unknown"` whenever the call names its repository in a way this
 * reader does not follow (`--git-dir`, `--work-tree`, a `GIT_DIR=` prefix): a
 * guard asking "is this the Singularity repo?" must then assume it is.
 */
export interface GitInvocation {
  subcommand: string | undefined;
  /** The directory git runs in: the call's cwd with every `-C` applied. */
  repo: { kind: "dir"; path: string } | { kind: "unknown"; why: string };
}

/** Global options (before the subcommand) that consume the next token. */
const VALUE_OPTIONS = new Set([
  "-c",
  "--exec-path",
  "--namespace",
  "--config-env",
]);
const REPO_OPTIONS = ["--git-dir", "--work-tree"];
const REPO_ENV = /(^|\s)(GIT_DIR|GIT_WORK_TREE)=/;

export function readGitInvocation(call: ShellCall): GitInvocation {
  let dir = call.cwd;
  let unknown: string | undefined = REPO_ENV.test(call.raw)
    ? "the repository is set through GIT_DIR / GIT_WORK_TREE"
    : undefined;
  const args = call.args;
  let i = 0;
  for (; i < args.length; i++) {
    const tok = args[i]!;
    if (!tok.startsWith("-")) break;
    if (tok === "-C") {
      dir = resolve(dir, args[++i] ?? "");
      continue;
    }
    const name = tok.split("=")[0]!;
    if (REPO_OPTIONS.includes(name)) {
      unknown = `the repository is set through ${name}`;
      if (!tok.includes("=")) i++;
      continue;
    }
    if (VALUE_OPTIONS.has(name) && !tok.includes("=")) i++;
  }
  return {
    subcommand: args[i],
    repo: unknown
      ? { kind: "unknown", why: unknown }
      : { kind: "dir", path: dir },
  };
}

/**
 * The Singularity CLI's entry point, relative to a checkout's root. A repo
 * whose root holds it lands work through `./equin push`; any other repo
 * (a separate package an agent publishes, a scratch clone) has no such flow.
 */
const CLI_ENTRY = "plugins/framework/plugins/cli/bin/index.ts";

export type RepoKind =
  | { kind: "singularity"; root: string }
  | { kind: "other"; root: string }
  | { kind: "not-a-repo" };

/**
 * Classifies the repository containing `dir`: walks up to the nearest `.git`
 * (a directory in a clone, a file in a worktree) and checks that root for the
 * Singularity CLI.
 */
export function classifyRepo(dir: string): RepoKind {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) {
      const isSingularity =
        CLI_NAMES.some((name) => existsSync(join(cur, name))) &&
        existsSync(join(cur, CLI_ENTRY));
      return { kind: isSingularity ? "singularity" : "other", root: cur };
    }
    const parent = dirname(cur);
    if (parent === cur) return { kind: "not-a-repo" };
    cur = parent;
  }
}
