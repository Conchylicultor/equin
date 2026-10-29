import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * There is exactly ONE class-token walk, and it lives here.
 *
 * This check replaces `class-token-walk-in-sync`, which held six hand-copied
 * copies byte-identical. That check could only ever police the copies it knew
 * about: eleven MORE rule files carried an older, weaker copy outside its
 * `EXPECTED` list, resolved no identifiers at all, and drifted for months with
 * nothing to say so. Holding N copies in sync is a weaker property than having
 * one — so the walk moved into `tooling/plugins/lint/core/class-token-walk.ts`
 * and is injected into each rule (rule files are dual-loaded under jiti, which
 * cannot resolve `@plugins/*`, so they take the TYPE by `import type` — which
 * jiti erases — and the VALUE from `buildLintConfig`).
 *
 * What is left to enforce is an ABSENCE: no rule file may declare a walk of its
 * own. That is one grep over every rule file, rather than a byte-comparison over
 * a hardcoded list, so a new rule is covered the day it is written.
 */
const WALK_MODULE =
  "plugins/framework/plugins/tooling/plugins/lint/core/class-token-walk.ts";

/**
 * The identifiers that name a class-token walk. A rule file declaring any of
 * them is re-growing the duplication this check exists to prevent; it should
 * take them from the injected toolkit instead.
 */
const BANNED_DECLARATIONS = [
  "function collectTokens",
  "function baseClass",
  "function ownClass",
  "const CLASS_ATTRS",
  "const CLASS_BUILDERS",
];

const check: Check = {
  id: "class-token-walk-single-source",
  description:
    "no lint rule file declares its own class-token walk — collectTokens / baseClass / ownClass / CLASS_ATTRS / CLASS_BUILDERS come from the injected shared toolkit",

  async run() {
    const offenders: string[] = [];

    for (const decl of BANNED_DECLARATIONS) {
      // `listCandidateSources` is the scan-tree/untracked-aware discovery shared
      // with `grepCode`, so a not-yet-committed rule file — exactly what an agent
      // produces when adding a rule — is seen instead of slipping past to runtime.
      const sources = await listCandidateSources({
        grepArg: decl,
        fixed: true,
        pathspecs: ["*.ts"],
      });
      for (const { rel } of sources) {
        // Only RULE files are in scope. The walk's own module legitimately
        // declares all four (it is the source), and this check's own file
        // carries the names inside the string constants above.
        if (!rel.includes("/lint/")) continue;
        if (rel === WALK_MODULE) continue;
        offenders.push(`${rel} — declares \`${decl}\``);
      }
    }

    if (offenders.length > 0) {
      return {
        ok: false,
        message:
          "lint rule file(s) declare their own class-token walk instead of taking the shared one:\n  " +
          [...new Set(offenders)].sort().join("\n  "),
        hint:
          `Delete the local declaration and take it from the injected toolkit: default-export a factory ` +
          `\`({ collectTokens, baseClass, CLASS_ATTRS, CLASS_BUILDERS }: LintToolkit) => createRule({ … })\`, ` +
          `\`import type { LintToolkit }\` from @plugins/framework/plugins/tooling/plugins/lint/core (the ` +
          `\`import type\` form is required — jiti erases it, a value import would break config loading), ` +
          `and list the rule under \`classRules\` (not \`rules\`) in the plugin's lint/index.ts.`,
      };
    }

    return { ok: true };
  },
};

export default check;
