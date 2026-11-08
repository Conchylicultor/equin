import { foreignTempPath } from "@plugins/infra/plugins/launcher/plugins/agent-scratch/core";
import type { OwnTemp } from "@plugins/infra/plugins/launcher/plugins/agent-scratch/core";
import {
  canonicalCommand,
  operandPath,
  parseArgv,
  redirectionTargets,
} from "../argv";
import { defineGuard } from "../define-guard";
import type { Denial } from "../define-guard";
import { parseShell } from "../parse-shell";
import type { ShellCall } from "../parse-shell";
import type { BashInput, FileInput, GuardContext } from "../types";
import { writeTargets } from "./main-writes";
import { innerScript, MAX_INNER_DEPTH } from "../inner-script";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * A fixed name in a temp directory every session shares is one file for every
 * agent that types it. On 2026-11-08 an agent wrote its push message to
 * `/tmp/msg.txt`, another session rewrote that file before the push read it,
 * and the commit carried the other task's message; over the 4 days before, 225
 * of 546 sessions used fixed `/tmp/<name>`s and 62 names were used by two
 * sessions or more (`tc.log`, `push.log`, `main.bundle`, `msg.txt`, …).
 *
 * So every session has a private scratch directory (`launcher/agent-scratch`;
 * `$EQUIN_SCRATCH` in an app-launched shell), and this guard refuses a call
 * that would WRITE a fixed name in a shared temp root outside it — the write is
 * where two sessions' files become one. Reading one stays free: a log a person
 * or a tool put there, a background task's output file.
 *
 * What counts as a write, per Bash call:
 *
 * - an output redirection, and a known writer's target (`writeTargets`: `cp`
 *   / `mv` destinations, `tee`, `mkdir`, `rm`, `sed -i`, …) — both resolved
 *   against the call's cwd, so `cd /tmp && cat > msg.txt` is caught;
 * - a `cd` / `pushd` into a shared temp root (or onto one: `cd /tmp`), the
 *   step that makes a later relative name land there (`cd /tmp && tar czf
 *   out.tgz x`);
 * - a command the argv grammar does not model, nor {@link READERS} lists,
 *   handed an absolute path in one (`--out /tmp/shot`, `--out=/tmp/shot`,
 *   `go build -o /tmp/gw`, `git bundle create /tmp/x`, `python3 /tmp/x.py`):
 *   whether it reads or writes the path is unknown. A modelled command (`cp`,
 *   `sed`, `rg`, …) is judged by its write targets alone, so `cp /tmp/a .`
 *   (a read) passes.
 *
 * Only LITERAL paths: a name held in a variable (`f=$(mktemp)`; `"$f"`) is not
 * resolved — and needs no guard, a `mktemp` name being unique by construction.
 * Heredoc bodies are documents, not commands (`parseShell` drops them), so a
 * message that MENTIONS `/tmp/x` passes.
 *
 * Measured over 4 days of transcripts (536 sessions, 24k Bash calls) before it
 * shipped: 1.7k calls would have been refused, ~60% of them by redirection —
 * the habit, not an edge case.
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

/**
 * The first foreign temp path one call would write, with how it was spotted,
 * or `null`.
 */
function foreignWrite(
  call: ShellCall,
  own: OwnTemp,
): { path: string; how: string } | null {
  for (const r of redirectionTargets(call)) {
    if (r.kind !== "local") continue;
    const p = foreignTempPath(r.path, own);
    if (p) return { path: p, how: `redirection target '${r.raw}'` };
  }
  for (const target of writeTargets(call)) {
    const p = foreignTempPath(target, own);
    if (p) return { path: p, how: `${call.name} target '${target}'` };
  }
  if (CHANGES_DIR.has(call.name)) {
    const to = call.args.find((a) => !a.startsWith("-"));
    if (to === undefined) return null;
    // Asked of a path inside the directory, so landing ON a root counts.
    const dir = operandPath(to, call.cwd);
    return foreignTempPath(`${dir}/`, own)
      ? { path: dir, how: `${call.name} into '${to}'` }
      : null;
  }
  const known = canonicalCommand(call.name);
  if (known === "git") {
    const sub = parseArgv(call).leading;
    if (sub === undefined || !GIT_FILE_WRITERS.has(sub)) return null;
  } else if (known) return null;
  if (READERS.has(call.name)) return null;
  for (const arg of call.args) {
    const value = valueOf(arg);
    if (!ABSOLUTE_WORD.test(value)) continue;
    const p = foreignTempPath(operandPath(value, call.cwd), own);
    if (p) return { path: p, how: `${call.name} argument '${arg}'` };
  }
  return null;
}

/** Over every call, and every script one hands a shell (`bash -c`, `eval`). */
function firstForeignWrite(
  cmd: string,
  cwd: string,
  own: OwnTemp,
  depth: number,
): { path: string; how: string } | null {
  for (const call of parseShell(cmd, cwd).calls) {
    const hit = foreignWrite(call, own);
    if (hit) return hit;
    const inner = depth < MAX_INNER_DEPTH ? innerScript(call) : undefined;
    const nested =
      inner === undefined
        ? null
        : firstForeignWrite(inner, call.cwd, own, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function denial(path: string, how: string, ctx: GuardContext): Denial {
  const dir = ctx.scratch.dir;
  const leaf = path.slice(path.lastIndexOf("/") + 1) || "file";
  const scratchVar = `$${envName("SCRATCH")}`;
  const where = ctx.scratch.delivered
    ? `your session's own scratch directory, \`${scratchVar}\` (${dir})`
    : `your session's own scratch directory, ${dir} (create it with \`mkdir -p ${dir}\`)`;
  const spelled = ctx.scratch.delivered
    ? `"${scratchVar}/${leaf}"`
    : `${dir}/${leaf}`;
  return {
    blocked: `Blocked: ${how} names '${path}', a fixed name in a temp directory every session on this machine shares.`,
    why: "Any other agent typing the same name writes the same file, between your write and your read — a push once carried another task's commit message this way (/tmp/msg.txt).",
    hint:
      `Use ${where}: ${spelled}. No other session writes there. ` +
      "An `rm` of an old fixed name there is refused too — it may be another session's file; leave it, the OS clears /tmp. " +
      "Or a name that is unique by construction: `f=$(mktemp)` / `d=$(mktemp -d)`. " +
      "For a commit message you need no file at all: `./equin push -m \"$(cat <<'EOF'\n…\nEOF\n)\"`.",
    skipEpilogue: true,
  };
}

export const sharedTmpGuard = defineGuard<
  FileInput & BashInput & { notebook_path?: string }
>({
  name: "shared-tmp",
  matcher: ["Bash", "Write", "Edit", "NotebookEdit"],
  check(input, ctx) {
    const own: OwnTemp = {
      scratchDir: ctx.scratch.dir,
      claudeSessionId: ctx.sessionId,
    };
    const file = input.file_path ?? input.notebook_path;
    if (file) {
      const p = foreignTempPath(file, own);
      return p ? denial(p, `the file path '${file}'`, ctx) : null;
    }
    if (!input.command) return null;
    const hit = firstForeignWrite(input.command, ctx.cwd, own, 0);
    return hit ? denial(hit.path, hit.how, ctx) : null;
  },
});
