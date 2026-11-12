import {
  canonicalCommand,
  operandPath,
  parseArgv,
  redirectionTargets,
} from "./argv";
import { innerScript, MAX_INNER_DEPTH } from "./inner-script";
import { parseShell } from "./parse-shell";
import type { ShellCall } from "./parse-shell";
import { writeTargets } from "./guards/main-writes";

/**
 * Which paths a Bash command WRITES, asked of a classifier — the scan behind
 * every guard that refuses a write by WHERE it lands (`shared-tmp`: a fixed
 * name in a shared temp root; `data-root-writes`: an undeclared entry at the
 * data root). Reading stays free.
 *
 * What counts as a write, per Bash call:
 *
 * - an output redirection, and a known writer's target (`writeTargets`: `cp`
 *   / `mv` destinations, `tee`, `mkdir`, `rm`, `sed -i`, …) — both resolved
 *   against the call's cwd, so `cd /tmp && cat > msg.txt` is caught;
 * - with `cdInto`, a `cd` / `pushd` into a flagged place (or onto one: `cd
 *   /tmp`), the step that makes a later relative name land there (`cd /tmp &&
 *   tar czf out.tgz x`);
 * - a command the argv grammar does not model, nor {@link READERS} lists,
 *   handed an absolute path in one (`--out /tmp/shot`, `--out=/tmp/shot`,
 *   `go build -o /tmp/gw`, `git bundle create /tmp/x`, `python3 /tmp/x.py`):
 *   whether it reads or writes the path is unknown. A modelled command (`cp`,
 *   `sed`, `rg`, …) is judged by its write targets alone, so `cp /tmp/a .`
 *   (a read) passes.
 *
 * A path held in a variable the command assigned a literal (`O=~/x; mkdir
 * $O`) arrives resolved (`parseShell`); one set by running something
 * (`f=$(mktemp)`) is not — and needs no guard there, a `mktemp` name being
 * unique by construction. Heredoc bodies are documents, not commands
 * (`parseShell` drops them), so a message that MENTIONS `/tmp/x` passes.
 */
const READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "stat",
  "file",
  "wc",
  "cut",
  "nl",
  "tac",
  "ffprobe",
  "egrep",
  "fgrep",
  "diff",
  "cmp",
  "jq",
  "md5",
  "shasum",
  "sha256sum",
  "xxd",
  "hexdump",
  "od",
  "strings",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "test",
  "[",
  "echo",
  "printf",
  "open",
  "lsof",
  // A template (`mktemp /tmp/x.XXXXXX`) names a file that does not exist yet
  // and will be unique.
  "mktemp",
]);

/**
 * The git subcommands that write a file or tree an absolute arg names (`git
 * bundle create <file>`, `git clone <url> <dir>`) — beyond the repo itself,
 * which `writeTargets` already resolves (`git -C <dir> commit`). Every other
 * subcommand reads (`git -C /tmp/r log`, `git diff --no-index /tmp/a /tmp/b`).
 */
const GIT_FILE_WRITERS = new Set([
  "bundle",
  "clone",
  "init",
  "worktree",
  "archive",
  "format-patch",
  "apply",
]);

const CHANGES_DIR = new Set(["cd", "pushd"]);

/** The value of a `--flag=<value>` or `key=<value>` word (`dd of=/tmp/x`), else the word itself. */
function valueOf(arg: string): string {
  const m = /^(?:-{1,2}[\w-]+|\w+)=(.*)$/s.exec(arg);
  return m ? (m[1] ?? "") : arg;
}

/** A path is one word: `-m "/tmp/x is gone"` is a sentence, not a file. */
const ABSOLUTE_WORD = /^(?:\/|~\/|\$HOME\/)\S*$/;

/** The path a classifier flagged, with how the write was spotted. */
export interface FlaggedWrite {
  path: string;
  how: string;
}

/**
 * Asked of every path a call would write: the path to report when it is one
 * the guard refuses, else `null`. Paths arrive resolved against the call's cwd.
 */
export type WriteClassifier = (path: string) => string | null;

export interface WriteScanOptions {
  /**
   * Also flag a `cd` / `pushd` INTO a flagged place (asked of `<dir>/`): the
   * step that makes a later relative name land there. For a shared temp root,
   * where any name is the hazard; not for a tree whose hazard is one new entry,
   * which the later write's own resolved path already shows.
   */
  cdInto?: boolean;
  /**
   * Commands whose targets are not writes for this guard (`rm` of a stray is
   * the repair, not the harm).
   */
  ignore?: ReadonlySet<string>;
}

/** The first path one call would write that `classify` flags, or `null`. */
function flaggedWrite(
  call: ShellCall,
  classify: WriteClassifier,
  opts: WriteScanOptions,
): FlaggedWrite | null {
  const known = canonicalCommand(call.name);
  if (known && opts.ignore?.has(known)) return null;
  for (const r of redirectionTargets(call)) {
    if (r.kind !== "local") continue;
    const p = classify(r.path);
    if (p) return { path: p, how: `redirection target '${r.raw}'` };
  }
  for (const target of writeTargets(call)) {
    const p = classify(target);
    if (p) return { path: p, how: `${call.name} target '${target}'` };
  }
  if (CHANGES_DIR.has(call.name)) {
    if (!opts.cdInto) return null;
    const to = call.args.find((a) => !a.startsWith("-"));
    if (to === undefined) return null;
    // Asked of a path inside the directory, so landing ON a root counts.
    const dir = operandPath(to, call.cwd);
    return classify(`${dir}/`)
      ? { path: dir, how: `${call.name} into '${to}'` }
      : null;
  }
  if (known === "git") {
    const sub = parseArgv(call).leading;
    if (sub === undefined || !GIT_FILE_WRITERS.has(sub)) return null;
  } else if (known) return null;
  if (READERS.has(call.name)) return null;
  for (const arg of call.args) {
    const value = valueOf(arg);
    if (!ABSOLUTE_WORD.test(value)) continue;
    const p = classify(operandPath(value, call.cwd));
    if (p) return { path: p, how: `${call.name} argument '${arg}'` };
  }
  return null;
}

/**
 * The first path one Bash command would write that `classify` flags — over
 * every call, and every script one hands a shell (`bash -c`, `eval`).
 */
export function firstFlaggedWrite(
  cmd: string,
  cwd: string,
  classify: WriteClassifier,
  opts: WriteScanOptions = {},
  depth = 0,
): FlaggedWrite | null {
  for (const call of parseShell(cmd, cwd).calls) {
    const hit = flaggedWrite(call, classify, opts);
    if (hit) return hit;
    const inner = depth < MAX_INNER_DEPTH ? innerScript(call) : undefined;
    const nested =
      inner === undefined
        ? null
        : firstFlaggedWrite(inner, call.cwd, classify, opts, depth + 1);
    if (nested) return nested;
  }
  return null;
}
