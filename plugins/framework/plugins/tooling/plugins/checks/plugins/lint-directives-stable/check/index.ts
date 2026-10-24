import {
  findDisplacedDirectives,
  formatDirectiveDisplacementReport,
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

const check: Check = {
  id: "lint-directives-stable",
  description:
    "no `eslint-disable-next-line` on this branch would suppress different code once the file is formatted",

  // Same impurity as `format-clean`, for the same reason: the first read is
  // `git merge-base`, a ref read the working-tree hash does not cover, so main
  // advancing (which moves the changed set) must re-run this. Deliberately NOT
  // `inputKeyed` — a recording FileSystemView cannot observe a ref read, so
  // declaring it would be a stale-PASS hole.
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

    // The SHARED changed set, never recomputed here — the build's format pass
    // asserts the same one, so the gate and this check cannot disagree about
    // which files are in scope.
    const files = await listChangedFormattableFiles(root);
    if (files.length === 0) return { ok: true };

    const displaced = await findDisplacedDirectives(root, files);
    if (displaced.length === 0) return { ok: true };

    return {
      ok: false,
      message: formatDirectiveDisplacementReport(displaced),
      hint: "`./equin build` and `./equin format` REFUSE to write these files until the directives are position-independent, so formatting will not fix this for you.",
    };
  },
};

export default check;
