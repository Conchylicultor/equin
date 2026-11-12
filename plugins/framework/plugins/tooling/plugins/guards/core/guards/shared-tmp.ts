import { foreignTempPath } from "@plugins/infra/plugins/launcher/plugins/agent-scratch/core";
import type { OwnTemp } from "@plugins/infra/plugins/launcher/plugins/agent-scratch/core";
import { defineGuard } from "../define-guard";
import type { Denial } from "../define-guard";
import type { BashInput, FileInput, GuardContext } from "../types";
import { firstFlaggedWrite } from "../write-scan";
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
 * Measured over 4 days of transcripts (536 sessions, 24k Bash calls) before it
 * shipped: 1.7k calls would have been refused, ~60% of them by redirection —
 * the habit, not an edge case.
 */
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
    const hit = firstFlaggedWrite(
      input.command,
      ctx.cwd,
      (p) => foreignTempPath(p, own),
      { cdInto: true },
    );
    return hit ? denial(hit.path, hit.how, ctx) : null;
  },
});
