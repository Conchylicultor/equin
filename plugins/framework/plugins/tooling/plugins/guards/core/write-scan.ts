import {
  canonicalCommand,
  operandPath,
  parseArgv,
  redirectionTargets,
} from "./argv";
import { innerScript, MAX_INNER_DEPTH } from "./inner-script";
import { parseShell, WRAPPERS } from "./parse-shell";
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
 * - a command the argv grammar does not model, nor {@link READERS} lists,
 *   handed an absolute path in one (`--out /tmp/shot`, `--out=/tmp/shot`,
 *   `go build -o /tmp/gw`, `git bundle create /tmp/x`, `python3 /tmp/x.py`):
 *   whether it reads or writes the path is unknown. A modelled command (`cp`,
 *   `sed`, `rg`, …) is judged by its write targets alone, so `cp /tmp/a .`
 *   (a read) passes; so is one whose inputs {@link OPERAND_ROLES} tells apart
 *   from its outputs (`sips in.png --out x`, `ffmpeg -i in.mp4 out.mp4`);
 * - with `cwdOperands`, a call run IN a flagged place that may write a name
 *   there ({@link writesInCwd}, fail-closed: `cd /tmp && tar czf out.tgz x`,
 *   `cd /tmp && curl -O <url>`, `cd /tmp/x && python3 - <<'EOF'`). The `cd`
 *   itself writes nothing, nor does a read run after it (`cd /tmp && ls`,
 *   `cd /tmp && rg x`, `cd /tmp && python3 -c "<a read>"`);
 * - `xargs <writer>` fed paths by the stage before it (`find /tmp/x -print0 |
 *   xargs -0 rm`): the producer's flagged path is what gets written.
 *
 * A wrapper (`timeout`, `time`, `nice`, …) is judged through what it wraps,
 * which `parseShell` emits as a call of its own.
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
  "tr",
  "column",
  "comm",
  "pwd",
  "which",
  "date",
  "ps",
  "otool",
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
]);

/**
 * Unmodelled commands whose argv says which operands are inputs: the words
 * that may be WRITTEN, of all of `args` (the rest are read). Bounded on
 * purpose — a command earns an entry when real refusals of its inputs were
 * measured (`replay-transcripts.ts --guards`), not to model every tool.
 */
const OPERAND_ROLES: Record<string, (args: string[]) => string[]> = {
  // `--out <path>` is the one output; without it sips rewrites its inputs.
  sips: (args) => {
    const i = args.findIndex((a) => a === "--out" || a === "-o");
    return i >= 0 ? args.slice(i + 1, i + 2) : args;
  },
  // `-i <path>` is an input; everything else may be an output.
  ffmpeg: (args) => args.filter((_, i) => args[i - 1] !== "-i"),
  // The starting points are read unless an action writes or runs something on
  // them; `-fprint*` / `-fls` name a file it writes.
  find: (args) => {
    const writes = args.filter((_, i) =>
      /^-f(?:print0?|printf|ls)$/.test(args[i - 1] ?? ""),
    );
    const acts = args.some((a) =>
      /^-(?:delete|exec|execdir|ok|okdir)$/.test(a),
    );
    // `-H` / `-L` / `-P` / `-E` / `-X` / `-x` / `-s` / `-d` / `-O<n>` / `-D <x>`
    // come before the roots.
    let from = 0;
    while (from < args.length && /^-(?:[HLPEXxsd]+|O\d*|D)$/.test(args[from]!))
      from += args[from] === "-D" ? 2 : 1;
    const rest = args.slice(from);
    const start = rest.findIndex((a) => /^[-(!]/.test(a));
    const roots = start < 0 ? rest : rest.slice(0, start);
    return acts ? [...roots, ...writes] : writes;
  },
};

/** Moves the shell; writes nothing (what runs after it is judged in its cwd). */
const CHANGES_DIR = new Set(["cd", "pushd", "popd"]);

/**
 * Commands that read and print, unless a flag names an output file: a reader
 * while the predicate says no, unmodelled (every absolute arg a possible
 * output) once it says yes. Fail-closed: any flag that may write counts.
 */
const READS_UNLESS: Record<string, (args: string[]) => boolean> = {
  // `-o`/`-O`/`-D`/`-c` (also clustered or glued) and their long forms.
  curl: (args) =>
    args.some(
      (a) =>
        /^-[A-Za-z]*[oODc]/.test(a) ||
        /^--(?:output|remote-name|dump-header|cookie-jar|trace|stderr|etag-save|hsts|alt-svc|libcurl)/.test(
          a,
        ),
    ),
  sort: (args) => args.some((a) => /^-[A-Za-z]*o|^--output/.test(a)),
  // `uniq [in [out]]`: any second operand (a flag's value counts — fail-closed).
  uniq: (args) => args.filter((a) => !a.startsWith("-")).length > 1,
  base64: (args) => args.some((a) => /^-[A-Za-z]*o|^--output/.test(a)),
};

function readsOnly(call: ShellCall): boolean {
  if (READERS.has(call.name)) return true;
  const writes = READS_UNLESS[call.name];
  return writes !== undefined && !writes(call.args);
}

/** Modelled commands that only read: `xargs <one of these>` writes nothing. */
const READ_ONLY_KNOWN = new Set(["rg", "grep", "fd", "ag", "tree", "du", "ls"]);

/** An awk program that writes: a `print … > file`, a pipe to a command, `system()`. */
const AWK_WRITE = /\b(?:print|printf)\b[^;}]*[>|]|system\s*\(|getline\s*</;

/** A sed script's `w <file>` command or `s///w <file>` flag. */
const SED_WRITE = /(?:^|[;{}\n]|\/[gpiIm0-9]*)\s*w\s*\S/;

/** git subcommands that only read the repo (or the cwd): every other may write there. */
const GIT_READS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "grep",
  "ls-files",
  "rev-parse",
  "blame",
  "cat-file",
  "describe",
  "rev-list",
  "shortlog",
]);

/**
 * Whether one call, run with a flagged place as its cwd, may write a name
 * there — fail-closed: anything not known to only read counts. A modelled
 * writer (`cp`, `mv`, `rm`, …) was judged by its resolved targets already, and
 * a reader, a `cd` and a wrapper (judged through what it wraps) write nothing.
 * Code is never read for intent: an interpreter or perl run there counts
 * (`python3 -c …`, `python3 - <<'EOF'`), as does an awk program that writes
 * and a sed script with a `w` command.
 */
function writesInCwd(call: ShellCall, known: string | undefined): boolean {
  if (readsOnly(call) || CHANGES_DIR.has(call.name)) return false;
  if (WRAPPERS.has(call.name) && call.name !== "script") return false;
  // Judged by its write operands, resolved against the cwd (`flaggedWrite`).
  if (Object.hasOwn(OPERAND_ROLES, call.name)) return false;
  if (known === "git") {
    const sub = parseArgv(call).leading;
    return sub === undefined || !GIT_READS.has(sub);
  }
  if (known === "awk") {
    const prog = call.args.find(
      (a, k) => !a.startsWith("-") && !/^-[Fvf]$/.test(call.args[k - 1] ?? ""),
    );
    return call.args.includes("-f") || AWK_WRITE.test(prog ?? "");
  }
  if (known === "sed") return call.args.some((a) => SED_WRITE.test(a));
  return known === undefined || known === "perl";
}

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
   * Also hand an unmodelled command its RELATIVE words when it runs in a
   * flagged place (its cwd asked as `<dir>/`): what makes `cd /tmp && tar czf
   * out.tgz x` a write while `cd /tmp && ls` is not. For a shared temp root,
   * where any name is the hazard; not for a tree whose hazard is one new entry.
   */
  cwdOperands?: boolean;
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
  if (
    opts.cwdOperands === true &&
    classify(`${call.cwd}/`) !== null &&
    writesInCwd(call, known)
  )
    return { path: call.cwd, how: `${call.name}, run in '${call.cwd}',` };
  if (known === "git") {
    const sub = parseArgv(call).leading;
    if (sub === undefined || !GIT_FILE_WRITERS.has(sub)) return null;
  } else if (known) return null;
  if (readsOnly(call) || CHANGES_DIR.has(call.name)) return null;
  // `script <file> cmd` is the one wrapper that writes a file of its own.
  if (WRAPPERS.has(call.name) && call.name !== "script") return null;
  const role = OPERAND_ROLES[call.name];
  const args = role?.(call.args) ?? call.args;
  for (const arg of args) {
    const value = valueOf(arg);
    // A modelled operand is a path even when relative (`find . -delete`).
    const path = ABSOLUTE_WORD.test(value)
      ? operandPath(value, call.cwd)
      : role !== undefined && /^[^-\s]\S*$/.test(value)
        ? operandPath(value, call.cwd)
        : undefined;
    if (path === undefined) continue;
    // Asked of a path inside, so a root itself (`find /tmp -delete`) counts.
    const p = classify(path) ?? classify(`${path}/`);
    if (p) return { path: p, how: `${call.name} argument '${arg}'` };
  }
  return null;
}

/**
 * `xargs <writer>` reading its operands from a pipe writes what the pipeline
 * before it names: any earlier stage's absolute flagged path stands for them
 * (`find /tmp/x | grep o | xargs rm`), and with `cwdOperands` a flagged cwd
 * does too (`cd /tmp && ls | xargs rm`).
 */
function fedWrite(
  calls: readonly ShellCall[],
  i: number,
  classify: WriteClassifier,
  opts: WriteScanOptions,
): FlaggedWrite | null {
  const call = calls[i]!;
  const wrapped = calls[i + 1];
  if (call.name !== "xargs" || !call.pipedIn || wrapped === undefined)
    return null;
  const writer = canonicalCommand(wrapped.name);
  if (writer === undefined || writer === "git" || READ_ONLY_KNOWN.has(writer))
    return null;
  const how = `xargs ${wrapped.name}`;
  if (opts.cwdOperands === true && classify(`${call.cwd}/`) !== null)
    return { path: call.cwd, how: `${how}, run in '${call.cwd}',` };
  // Back through the stages that feed this one (each piped into the next).
  for (let j = i - 1; j >= 0 && calls[j + 1]!.pipedIn; j--) {
    const stage = calls[j]!;
    for (const arg of stage.args) {
      const value = valueOf(arg);
      if (!ABSOLUTE_WORD.test(value)) continue;
      const p = classify(operandPath(value, stage.cwd));
      if (p) return { path: p, how: `${how} fed by '${stage.name}'` };
    }
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
  const calls = parseShell(cmd, cwd).calls;
  for (const [i, call] of calls.entries()) {
    const hit =
      flaggedWrite(call, classify, opts) ?? fedWrite(calls, i, classify, opts);
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
