import { ESLintUtils } from "@typescript-eslint/utils";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import type { LintRuleDocs } from "./build-lint-config";

/** The repo root as a URL, from this file's own place in it (`plugins/framework/plugins/tooling/plugins/lint/core/`). */
const REPO_ROOT = new URL("../../../../../../../", import.meta.url).href;

/**
 * The one rule creator every lint rule is made with:
 * `const createRule = lintRuleCreator(import.meta.url);`.
 *
 * A rule's docs URL is its own source file on the published repository — the
 * only documentation a rule has — so it is derived, never written: a rule
 * cannot link to a repository or a path that does not exist. Its `meta.docs`
 * is typed `LintRuleDocs`, so `requiresTypeChecking` type-checks on every rule.
 * `rule-kind-safety/no-raw-rule-creator` keeps `ESLintUtils.RuleCreator` out of rule files.
 */
export function lintRuleCreator(ruleModuleUrl: string) {
  if (!ruleModuleUrl.startsWith(REPO_ROOT)) {
    throw new Error(
      `lintRuleCreator: ${ruleModuleUrl} is outside the repo root ${REPO_ROOT}; pass the rule file's own import.meta.url`,
    );
  }
  const url = `${SOURCE_REPO_URL}/blob/main/${ruleModuleUrl.slice(REPO_ROOT.length)}`;
  return ESLintUtils.RuleCreator<LintRuleDocs>(() => url);
}
