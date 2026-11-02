/**
 * Tests for the `no-raw-rule-creator` lint rule: `ESLintUtils.RuleCreator` (or
 * any `.RuleCreator` member) is flagged; `lintRuleCreator(import.meta.url)` is
 * not.
 */

import rule from "./no-raw-rule-creator";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-raw-rule-creator", rule, {
  valid: [
    { code: "const createRule = lintRuleCreator(import.meta.url);" },
    { code: "const s = ESLintUtils.getParserServices(context);" },
  ],
  invalid: [
    {
      code: 'const createRule = ESLintUtils.RuleCreator((name) => "https://x/" + name);',
      errors: [{ messageId: "raw" }],
    },
    {
      code: "const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(() => url);",
      errors: [{ messageId: "raw" }],
    },
  ],
});
