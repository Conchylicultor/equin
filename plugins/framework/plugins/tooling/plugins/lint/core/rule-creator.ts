import { ESLintUtils } from "@typescript-eslint/utils";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import type { LintRuleDocs } from "./build-lint-config";

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
  const file = decodeURIComponent(new URL(ruleModuleUrl).pathname);
  const root = `${REPO_ROOT}/`;
  if (!file.startsWith(root)) {
    throw new Error(
      `lintRuleCreator: ${ruleModuleUrl} is outside the repo root ${REPO_ROOT}; pass the rule file's own import.meta.url`,
    );
  }
  const url = `${SOURCE_REPO_URL}/blob/main/${file.slice(root.length)}`;
  return ESLintUtils.RuleCreator<LintRuleDocs>(() => url);
}
