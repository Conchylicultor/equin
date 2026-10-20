import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  EXEMPT_RULE_IDS_REL_PATH,
  formatGenerated,
  renderExemptRuleIds,
  exemptRuleIdsPath,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { listAllChecks } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  lintRuleIds,
  loadLintContributions,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import {
  describeExemption,
  exemptManifestPaths,
  loadExemptions,
  ruleIdProblems,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";

const ruleIdsInSync: Check = {
  id: "exempt:rule-ids-in-sync",
  description:
    "exempt/core/rule-ids.generated.ts (the ExemptableRuleId union) is exactly what the live lint rules and checks' `exemptable` ids render",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const actual = await repo.read(EXEMPT_RULE_IDS_REL_PATH);
    const expected = await formatGenerated({
      file: exemptRuleIdsPath(repo.root),
      content: await renderExemptRuleIds(repo.root),
    });
    if (actual === expected) return { ok: true };
    return {
      ok: false,
      message: `${EXEMPT_RULE_IDS_REL_PATH} is ${actual === null ? "missing" : "out of sync with the live rule set"}`,
      hint: "Run `./singularity build` (it regenerates the union) and commit the file.",
    };
  },
};

/** Each problem with the loaded manifests; empty when they are all valid. */
async function manifestProblems(ctx: CheckContext): Promise<string[]> {
  const repo = await ctx.repo();
  await Promise.all(exemptManifestPaths(repo).map((p) => repo.read(p)));

  let exemptions: ResolvedExemption[];
  try {
    exemptions = await loadExemptions(repo);
  } catch (err) {
    // A manifest that fails validation (an escaping path, a missing reason,
    // a debt entry without a task) is THE finding here, not a crash.
    if (!(err instanceof Error)) throw err;
    return [err.message];
  }

  const problems: string[] = [];

  for (const e of exemptions) {
    if (!repo.has(e.target) && repo.under(e.target).length === 0) {
      problems.push(
        `stale: ${e.manifest} exempts "${e.path}", which does not exist (${e.target}) — ${describeExemption(e)}`,
      );
    }
  }

  const seen = new Map<string, ResolvedExemption>();
  for (const e of exemptions) {
    const key = `${e.rule}\0${e.target}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, e);
    } else {
      problems.push(
        `duplicate: ${e.target} is exempted from ${e.rule} twice — in ${first.manifest} and ${e.manifest}`,
      );
    }
  }

  const [contributions, checks] = await Promise.all([
    loadLintContributions(repo.root),
    listAllChecks(),
  ]);
  const lint = lintRuleIds(contributions);
  const known = new Set([
    ...lint.known,
    ...checks.flatMap((c) => Object.keys(c.exemptable ?? {})),
  ]);
  problems.push(...ruleIdProblems(exemptions, { known, closed: lint.closed }));
  return problems;
}

const manifestsValid: Check = {
  id: "exempt:manifests-valid",
  description:
    "Every exempt/index.ts entry is valid: a reasoned (and, for debt, tasked) entry naming a live, non-closed rule, for an existing path inside its own plugin, declared once",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const problems = await manifestProblems(ctx);
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${problems.length} exemption problem(s):\n    ${problems.join("\n    ")}`,
      hint: 'Fix or delete the named entries in their exempt/index.ts. A path is relative to its own plugin (a file, a directory for its subtree, or "."); a rule id is a contributed lint rule `<ns>/<rule>` or an id a check declares `exemptable`.',
    };
  },
};

export default [ruleIdsInSync, manifestsValid];
