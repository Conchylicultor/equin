/**
 * Tests for the `no-raw-rule-tester` lint rule: a `RuleTester` constructed or
 * subclassed by hand (named, aliased or through a namespace import) is
 * flagged; the lint/core/testing factories and a type-only import are not.
 */

import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-raw-rule-tester";

const ruleTester = createRuleTester();
const raw = [{ messageId: "raw" }];

ruleTester.run("no-raw-rule-tester", rule, {
  valid: [
    {
      code: `import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
             const t = createRuleTester();`,
    },
    {
      code: `import type { RuleTester } from "eslint";
             type Cases = Parameters<RuleTester["run"]>[2];`,
    },
    // Some other package's RuleTester is not eslint's.
    { code: `import { RuleTester } from "./local"; new RuleTester();` },
  ],
  invalid: [
    {
      code: `import { RuleTester } from "eslint"; const t = new RuleTester({});`,
      errors: raw,
    },
    {
      code: `import { RuleTester as RT } from "@typescript-eslint/rule-tester"; new RT();`,
      errors: raw,
    },
    {
      code: `import * as eslint from "eslint"; new eslint.RuleTester();`,
      errors: raw,
    },
    {
      code: `import { RuleTester } from "eslint"; class Mine extends RuleTester {}`,
      errors: raw,
    },
  ],
});
