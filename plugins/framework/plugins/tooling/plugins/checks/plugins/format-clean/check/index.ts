import {
  findUnformatted,
  listChangedFormattableFiles,
} from "@plugins/framework/plugins/tooling/plugins/format/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(): Promise<CheckResult>;
  cacheSignature?(): string | null;
};

/** How many offending paths the failure message names before summarizing. */
const MAX_LISTED = 20;

const check: Check = {
  id: "format-clean",
  description:
    "every line of .ts/.tsx this branch changed matches prettier's output (`./singularity build` and `./singularity format` write exactly this; untouched lines are left as they are)",

  // Deliberately NOT `inputKeyed`: that contract requires the check's ENTIRE
  // transitive read surface to route through the recording FileSystemView, and
  // the first read here is `git merge-base` — a ref read the view cannot
  // observe. Declaring it would be a stale-PASS hole.
  //
  // Impure for the same reason: the working-tree hash the runner caches a PASS
  // on does not cover git refs, so main advancing (which moves the merge-base
  // and therefore the changed set) must re-run this. Fold the merge-base sha in.
  cacheSignature() {
    try {
      const proc = Bun.spawnSync(["git", "merge-base", "HEAD", "main"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!proc.success) return null;
      const base = proc.stdout.toString().trim();
      return base.length > 0 ? base : null;
      // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- a signature is a pure best-effort optimization; any failure (no git, no main ref) safely degrades to "never cache" (return null), which only re-runs the check
    } catch {
      return null;
    }
  },

  async run() {
    const root = await getWorktreeRoot();

    // The SHARED changed-set implementation the build's format pass uses. If
    // this check computed its own set, the build would format one set and the
    // check would assert another.
    const files = await listChangedFormattableFiles(root);
    // Short-circuit before prettier is ever loaded: a branch that touched no
    // formattable file pays nothing.
    if (files.length === 0) return { ok: true };

    const bad = await findUnformatted(root, files);
    if (bad.length === 0) return { ok: true };

    const listed = bad.slice(0, MAX_LISTED).join("\n  ");
    const more =
      bad.length > MAX_LISTED ? `\n  …and ${bad.length - MAX_LISTED} more` : "";
    return {
      ok: false,
      message: `${bad.length} changed file(s) have changed lines that do not match prettier's output:\n  ${listed}${more}`,
      hint: "Run `./singularity format` (seconds) and commit the result, or `./singularity build`, which runs the same pass.",
    };
  },
};

export default check;
