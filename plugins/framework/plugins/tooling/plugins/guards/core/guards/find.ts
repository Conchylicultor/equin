import { parseFindArgv } from "../argv";
import { rewriteCalls, type CallWords, type Splice } from "../call-splice";
import { defineGuard } from "../define-guard";
import type { ShellCall } from "../parse-shell";
import type { BashInput, GuardContext } from "../types";

const unbounded = (c: ShellCall): boolean =>
  c.name === "find" &&
  !c.args.includes("-prune") &&
  !c.args.includes("-maxdepth");

/**
 * The directories that make a find unbounded inside a checkout — dependency
 * trees, git's object store, the other worktrees — skipped by name. What is
 * left of a checkout is a few thousand directories (7.6k measured), well
 * under the ~65k DIR FDs that crashed the machine.
 */
const PRUNED_NAMES = ["node_modules", ".git"];
const PRUNE = `\\( -name node_modules -o -name .git -o -path '*/.claude/worktrees' \\) -prune -o`;

/**
 * Primaries that print or act: with one present, find adds no implicit
 * `-print`, so the rewrite must not add one either.
 */
const ACTIONS = new Set([
  "-print",
  "-print0",
  "-printf",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ls",
  "-fls",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-quit",
]);

/**
 * `-prune` does nothing under depth-first traversal (`-depth`, BSD `-d`, and
 * `-delete`, which implies it), so a rewrite there would bound nothing.
 */
const DEPTH_FIRST = new Set(["-depth", "-d", "-delete"]);

/**
 * The splices that make one `find` skip `PRUNED_NAMES` — or `null` when that
 * would not bound it or would change what it finds: a starting point outside
 * the agent's workspace (`~`, `/`: pruning a checkout's heavy dirs bounds
 * nothing there), one spelled through a variable, one that IS a pruned
 * directory (it would prune itself and list nothing), or a depth-first walk.
 *
 * The expression is parenthesised whole, so `-name a -o -name b` keeps its
 * meaning behind the `-o` the prune adds, and gets the `-print` find would have
 * implied once the prune makes the expression carry an action of its own.
 */
function pruneSplices(
  call: ShellCall,
  words: CallWords,
  ctx: GuardContext,
): Splice[] | null {
  const argv = parseFindArgv(call);
  if (!argv || argv.paths.length === 0 || argv.options.has("d")) return null;
  const root = ctx.workRoot;
  for (const p of argv.paths) {
    if (p.kind !== "local" || /[$~`]/.test(p.raw)) return null;
    if (p.path !== root && !p.path.startsWith(`${root}/`)) return null;
    if (PRUNED_NAMES.includes(p.path.split("/").at(-1)!)) return null;
    if (p.path.endsWith("/.claude/worktrees")) return null;
  }
  const expression = call.args.slice(argv.expression);
  if (expression.some((a) => DEPTH_FIRST.has(a))) return null;
  const afterPaths = words.args[argv.expression - 1]!.end;
  if (expression.length === 0)
    return [{ from: afterPaths, to: afterPaths, text: ` ${PRUNE} -print` }];
  const end = words.args.at(-1)!.end;
  const acts = expression.some((a) => ACTIONS.has(a));
  return [
    { from: afterPaths, to: afterPaths, text: ` ${PRUNE} \\(` },
    { from: end, to: end, text: acts ? " \\)" : " \\) -print" },
  ];
}

export const findGuard = defineGuard<BashInput>({
  name: "find",
  matcher: "Bash",
  check(input, ctx) {
    const cmd = input.command;
    if (!cmd) return null;
    if (!cmd.includes("find")) return null;
    const rewritten = rewriteCalls(cmd, ctx.cwd, unbounded, (call, words) =>
      pruneSplices(call, words, ctx),
    );
    if (rewritten !== null && rewritten !== cmd)
      return {
        rewrite: { command: rewritten },
        note: `Your \`find\` was rewritten to skip node_modules, .git and .claude/worktrees (a \`-prune\` clause, your expression unchanged) and ran as:\n  ${rewritten}\nAn unbounded find has crashed macOS on this machine (Claude Code's bfs shim holds a directory FD per frontier entry). Nothing under those directories is listed; to search inside one, start find there or bound it with -maxdepth.`,
      };
    if (rewritten === cmd) return null;
    return {
      blocked:
        "On this machine `find` is rerouted by Claude Code's shell shim to a bundled bfs that holds an unbounded directory FD frontier.",
      why: "Broad finds against trees with node_modules / worktrees accumulate ~65k DIR FDs and have crashed macOS. A find whose starting points all sit in your workspace is rewritten to prune those directories; this one could not be (a starting point outside the workspace, through a variable, or itself a pruned directory; a depth-first walk; or a command shape the rewriter does not model).",
      hint: "Prefer `rg --files -g '<glob>'` (or `fd '<regex>'`) — they are faster, respect .gitignore, and have bounded FDs. If you genuinely need find's predicates (-mtime/-size/-perm/etc.), scope with -prune (e.g. `find . \\( -name node_modules -o -name .git -o -name .claude \\) -prune -o -name '*.ts' -print`) or -maxdepth N.",
    };
  },
});
