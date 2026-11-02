// The toolkit `buildLintConfig` hands every class-rule factory, so a rule's
// test constructs the rule exactly as the lint config does.
export { lintToolkit } from "./toolkit";
// The one way a rule test builds its RuleTester (bun's harness; a fresh
// project service per typed suite).
export {
  createRuleTester,
  createTypedRuleTester,
  type LintRuleTester,
} from "./rule-tester";
