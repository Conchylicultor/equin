import { canonicalCommand, parseArgv, redirectionTargets } from "../argv";
import type { FileOperand, KnownCommand } from "../argv";
import { defineGuard } from "../define-guard";
import { parseShell } from "../parse-shell";
import type { ShellCall } from "../parse-shell";
import type { BashInput } from "../types";

/**
 * Every command this guard polices must have an entry in the argv grammar —
 * policing one without a grammar is a TYPE ERROR, not a silent fallback to the
 * old "any token that is not flag-shaped is a path" guess. That is what keeps
 * the two lists from drifting apart as either one grows.
 */
type Policed = KnownCommand;

const DEST_LAST_CMDS = new Set<Policed>(["cp", "mv", "rsync", "install"]);
const ALL_ARGS_CMDS = new Set<Policed>([
  "rm",
  "rmdir",
  "tee",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "shred",
  "unlink",
]);
const INPLACE_CMDS = new Set<Policed>(["sed", "perl"]);
const GIT_MUTATING_SUBCMDS = new Set([
  "rm",
  "add",
  "commit",
  "reset",
  "checkout",
  "restore",
  "stash",
  "clean",
  "revert",
  "cherry-pick",
  "merge",
  "rebase",
  "push",
]);

/** Only a local operand names a path on this machine; a remote spec does not. */
function localPaths(operands: readonly FileOperand[]): string[] {
  return operands.flatMap((o) => (o.kind === "local" ? [o.path] : []));
}

/**
 * Every filesystem path a single call would write to, already resolved against
 * the call's effective working directory (so a leading `cd` is honored). Empty
 * when the call writes nothing we police.
 */
export function writeTargets(call: ShellCall): string[] {
  const name = canonicalCommand(call.name);
  if (!name) return [];
  const argv = parseArgv(call);

  if (DEST_LAST_CMDS.has(name)) {
    // `install -d` creates directories: every operand is a destination, and the
    // last-operand rule would have skipped `install -d <dir>` entirely.
    if (name === "install" && argv.flags.has("d"))
      return localPaths(argv.files);
    // An explicit destination beats position. Reading the last operand under
    // `cp -t <dir> a b` named a SOURCE file and missed the real write.
    if (argv.targetDir) return localPaths([argv.targetDir]);
    const dest = argv.files[argv.files.length - 1];
    return argv.files.length >= 2 && dest ? localPaths([dest]) : [];
  }
  if (ALL_ARGS_CMDS.has(name)) return localPaths(argv.files);
  // `ln` writes only the link. The grammar already turned every target operand
  // into a `link-target` (no path, so `localPaths` drops it), leaving the one
  // place the link is created: `-t DIR`, else the last operand (a link, or a
  // dir it lands in), else `<cwd>/basename(T)` for a lone target.
  if (name === "ln")
    return localPaths(argv.targetDir ? [argv.targetDir] : argv.files);
  if (INPLACE_CMDS.has(name)) {
    // Read the flag SET, never `startsWith("-i")`: that probe missed `perl -pi`
    // and `sed --in-place`, and matched an `-i` that was another flag's value.
    const inPlace = argv.flags.has("i") || argv.flags.has("in-place");
    return inPlace ? localPaths(argv.files) : [];
  }
  if (name === "git") {
    // git always touches the repo containing its working directory, regardless
    // of any path args — so the subcommand decides IF, and `-C` decides WHERE.
    const subcmd = argv.leading;
    if (!subcmd || !GIT_MUTATING_SUBCMDS.has(subcmd)) return [];
    const dir = argv.targetDir;
    return dir?.kind === "local" ? [dir.path] : [call.cwd];
  }
  return [];
}

export const mainWritesGuard = defineGuard<BashInput>({
  name: "main-writes",
  matcher: "Bash",
  bypassToken: ".allow-main",
  check(input, ctx) {
    // Both boundaries come from the context, never from raw cwd — the hook
    // cwd tracks the shell's persistent `cd`, and a subdirectory cwd would both
    // mis-derive the repo root (silently un-protecting main) and flag
    // legitimate writes to sibling dirs of the agent's own workspace.
    const repoRoot = ctx.protectedRoot;
    if (repoRoot === null) return null;
    const cmd = input.command;
    if (!cmd) return null;

    const worktreeRoot = ctx.workRoot;

    // A resolved, absolute path that lands inside the repo root but outside the
    // agent's own worktree IS a write to main. Relative args are resolved
    // against each call's effective cwd before reaching here.
    const isMainBranch = (p: string) =>
      (p === repoRoot || p.startsWith(`${repoRoot}/`)) &&
      p !== worktreeRoot &&
      !p.startsWith(`${worktreeRoot}/`);

    for (const call of parseShell(cmd, ctx.cwd).calls) {
      for (const r of redirectionTargets(call)) {
        if (r.kind === "local" && isMainBranch(r.path)) {
          return violation(
            `redirection target '${r.raw}'`,
            repoRoot,
            worktreeRoot,
          );
        }
      }
      for (const target of writeTargets(call)) {
        if (isMainBranch(target)) {
          return violation(
            `${call.name} target '${target}'`,
            repoRoot,
            worktreeRoot,
          );
        }
      }
    }
    return null;
  },
});

function violation(target: string, repoRoot: string, worktreeRoot: string) {
  return {
    blocked: `Blocked write to main branch: ${target} is under ${repoRoot} (outside your workspace ${worktreeRoot}).`,
    why: "Writing directly to the main branch from another workspace corrupts shared state — a previous agent ran `cp <worktree>/file <main>/file` and leaked uncommitted changes.",
    hint: `Write to files inside your workspace (${worktreeRoot}) instead.`,
  };
}
