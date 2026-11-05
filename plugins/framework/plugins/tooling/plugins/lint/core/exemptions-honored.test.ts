// Every declared lint exemption, honored where exemptions live: the config
// builder. A rule knows nothing of who is exempt from it — its own RuleTester
// suite proves it fires — so "the owner's own files are silent" is a property
// of the exempt/ manifests and of the two consumers that read them, and this is
// the one place it is tested, for every manifest at once:
//
//   - "config-off" (the IDE config): the rule resolves to "off" on the target;
//   - "report" (the type-check worker): the rule stays on, and the exemption
//     index the worker filters messages through matches the target.

import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { describe, expect, it } from "bun:test";
import { statSync } from "fs";
import { join } from "path";

import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  createExemptionIndex,
  loadExemptions,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { ESLint, type Linter } from "eslint";
import {
  buildLintConfig,
  lintExemptions,
  loadLintContributions,
} from "./build-lint-config";

const ROOT = REPO_ROOT;

/** A file the exemption covers: the target itself, or one inside it. */
function probeOf(e: ResolvedExemption): string {
  return statSync(join(ROOT, e.target)).isDirectory()
    ? `${e.target}/exemptions-honored-probe.ts`
    : e.target;
}

function severity(entry: Linter.RuleEntry | undefined): unknown {
  return Array.isArray(entry) ? entry[0] : entry;
}

async function ruleAt(
  config: Linter.Config[],
  rule: string,
  file: string,
): Promise<unknown> {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: config,
  });
  const resolved = (await eslint.calculateConfigForFile(join(ROOT, file))) as
    Linter.Config | undefined;
  if (resolved === undefined) return "ignored";
  return severity(resolved.rules?.[rule]);
}

const repo = await loadRepoFiles(ROOT);
const [exemptions, contributions] = await Promise.all([
  loadExemptions(repo),
  loadLintContributions(ROOT),
]);
const lint = lintExemptions(exemptions, contributions);

describe("lint exemptions are honored", () => {
  it("the repo declares lint exemptions", () => {
    expect(lint.length).toBeGreaterThan(0);
  });

  it('"config-off": every exempted rule is off on its target', async () => {
    const config = await buildLintConfig({
      root: ROOT,
      typeSource: { none: true },
      exemptions: { mode: "config-off", manifests: repo },
    });
    const notOff: string[] = [];
    for (const e of lint) {
      const s = await ruleAt(config, e.rule, probeOf(e));
      if (s !== "off" && s !== 0) {
        notOff.push(`${e.rule} on ${probeOf(e)} (${e.manifest}): ${String(s)}`);
      }
    }
    expect(notOff).toEqual([]);
  });

  it('"report": the exemption index matches every target', () => {
    const index = createExemptionIndex(exemptions);
    const unmatched = lint.filter(
      (e) => index.exemptionsFor(e.rule).match(probeOf(e)) === undefined,
    );
    expect(unmatched.map((e) => `${e.rule} on ${e.target}`)).toEqual([]);
  });
});
