import { dataRootWriteViolationSync } from "@plugins/infra/plugins/paths/core";
import type { DataRootWriteViolation } from "@plugins/infra/plugins/paths/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { operandPath } from "../argv";
import { defineGuard } from "../define-guard";
import type { Denial } from "../define-guard";
import type { BashInput, FileInput, GuardContext } from "../types";
import { firstFlaggedWrite } from "../write-scan";

/**
 * Everything at the data root (`~/.equin`) is a declared directory with an
 * owner (`infra/paths` CLAUDE.md, § The data root is a registry), and
 * `paths:no-undeclared-data-dirs` fails on anything else — hourly, on main, as
 * a `host-check` report nobody can clear but by hand. On 2026-11-10 two agents
 * put screenshots there: one copied its browser screenshots into
 * `~/.equin/demo-audit-2026-11-10/` so the tasks it filed could cite files that
 * outlive its session; another, refused by `launcher:env-names` for spelling
 * `process.env.EQUIN_SCRATCH` in a probe script, rewrote the script's output
 * to `~/.equin/tmp-probe-…png`. Nothing refused either write; the audit fired
 * every hour after.
 *
 * So this guard asks, of every write an agent makes by hand (the same scan
 * `shared-tmp` runs — `write-scan`), the audit's own question BEFORE the write
 * lands: would it mint an entry at the root nothing declares
 * (`dataRootWriteViolationSync`)? A write INSIDE what already stands — a declared
 * dir, the prototypes tree, a worktree's data dir — passes; so does every
 * read, and every removal (`rm` of a stray is the repair).
 */
const REMOVERS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
]);

function denial(
  v: DataRootWriteViolation,
  path: string,
  how: string,
  ctx: GuardContext,
): Denial {
  const scratchVar = `$${envName("SCRATCH")}`;
  const scratch = ctx.scratch.delivered
    ? `\`${scratchVar}\` (${ctx.scratch.dir})`
    : `${ctx.scratch.dir} (create it with \`mkdir -p ${ctx.scratch.dir}\`)`;
  const what =
    v.kind === "root-entry"
      ? `'${v.entry}' at the top of the data root, which is not a data-dir kind`
      : `'${v.entry}', a data dir that does not exist and so is declared by nothing`;
  return {
    blocked: `Blocked: ${how} writes '${path}' — it would create ${what}.`,
    why: "Everything under the data root is a declared directory with an owner; a hand-made entry is an orphan `paths:no-undeclared-data-dirs` reports every hour until someone deletes it.",
    hint:
      `Screenshots, probes and other working files go in your session's scratch directory, ${scratch}. ` +
      `In a script, read it with \`readEnv("SCRATCH")\` (\`@plugins/infra/plugins/launcher/plugins/env-names/core\`) or take an \`--out\` argument — never a path under the data root. ` +
      "Evidence a task you file must keep goes WITH the task: attach the file to it, or describe what it shows. " +
      "A new durable directory is a `defineDataDir` declaration in a plugin's `data-dirs/index.ts`, created by its own `ensure()` — never by hand.",
  };
}

export const dataRootWritesGuard = defineGuard<
  FileInput & BashInput & { notebook_path?: string }
>({
  name: "data-root-writes",
  matcher: ["Bash", "Write", "Edit", "NotebookEdit"],
  check(input, ctx) {
    const file = input.file_path ?? input.notebook_path;
    if (file) {
      const path = operandPath(file, ctx.cwd);
      const v = dataRootWriteViolationSync(path, ctx.dataRoot);
      return v ? denial(v, path, `the file path '${file}'`, ctx) : null;
    }
    if (!input.command) return null;
    let found: DataRootWriteViolation | null = null;
    const hit = firstFlaggedWrite(
      input.command,
      ctx.cwd,
      (p) => {
        found = dataRootWriteViolationSync(p, ctx.dataRoot);
        return found ? p : null;
      },
      { ignore: REMOVERS },
    );
    return hit && found ? denial(found, hit.path, hit.how, ctx) : null;
  },
});
