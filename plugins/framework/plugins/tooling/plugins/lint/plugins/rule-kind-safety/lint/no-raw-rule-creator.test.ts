/**
 * Tests for the `no-raw-rule-creator` lint rule: `ESLintUtils.RuleCreator` (or
 * any `.RuleCreator` member) is flagged; `lintRuleCreator(import.meta.url)` is
 * not.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-raw-rule-creator";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

// `RuleTester.run` drives the test harness itself (it calls the ambient
// describe/it that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-raw-rule-creator",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
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
  },
);
