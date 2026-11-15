import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  compositionOutputIgnorePatterns,
  deadCompositionOutputs,
  isCompositionOutputName,
} from "@plugins/framework/plugins/tooling/plugins/codegen/plugins/composition-registries/core";

const GITIGNORE = ".gitignore";

/** The `.gitignore` lines that would hide a per-composition output. */
function compositionLines(gitignore: string): string[] {
  return gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) =>
      isCompositionOutputName(line.slice(line.lastIndexOf("/") + 1)),
    );
}

/**
 * `.gitignore` hides EXACTLY the locations a composition's build writes
 * (`compositionOutputIgnorePatterns`), and no per-composition output is in
 * the file set.
 *
 * The two halves are one rule: hidden exactly, a live output is never in the
 * file set (so `build` / `push` never delete one), and a retired output —
 * left by an older build at a location no writer uses any more — is in it, so
 * it is deleted rather than hidden forever (`deadCompositionOutputs`). A
 * broader pattern (`*.composition.*.generated.ts`) is what let the post-web
 * manifests' per-composition copies outlive their writer.
 */
const check: Check = {
  id: "composition-outputs-ignored",
  description:
    ".gitignore hides exactly the per-composition outputs a build writes, and none is left where git sees it",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const gitignore = await repo.read(GITIGNORE);
    if (gitignore === null) {
      return { ok: false, message: `${GITIGNORE} is missing.` };
    }
    const expected = await compositionOutputIgnorePatterns(repo);
    const actual = compositionLines(gitignore);
    const problems: string[] = [];
    const missing = expected.filter((p) => !actual.includes(p));
    const extra = actual.filter((p) => !expected.includes(p));
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        `${GITIGNORE} must hide exactly the per-composition outputs a build writes ` +
          `(compositionOutputLocations, composition-registries/core) — one line each:\n` +
          expected.map((p) => `  ${p}`).join("\n") +
          (missing.length > 0
            ? `\nMissing (a live output would be in the file set, and deleted):\n` +
              missing.map((p) => `  ${p}`).join("\n")
            : "") +
          (extra.length > 0
            ? `\nNot written by any build (it hides a retired output instead of letting it be deleted):\n` +
              extra.map((p) => `  ${p}`).join("\n")
            : ""),
      );
    }
    const dead = deadCompositionOutputs(repo);
    if (dead.length > 0) {
      problems.push(
        `Per-composition outputs no build writes are in the tree (\`./equin build\` deletes them; ` +
          `never commit one):\n` +
          dead.map((p) => `  ${p}`).join("\n"),
      );
    }
    return problems.length === 0
      ? { ok: true }
      : { ok: false, message: problems.join("\n\n") };
  },
};

export default check;
