/**
 * Tests for the `no-declare-identifier` lint rule. Run with `bun test` from the
 * repo root (or this file's directory).
 *
 * The rule bans `declare` as a value binding name, because Bun's TS transform
 * parses a statement beginning with `declare` as a TS ambient declaration and
 * silently erases it from the emitted JS. It must fire on every binding form
 * (const/let/var, function & class names, params, imports, destructuring) but
 * never on look-alikes (`declareResource`), property names (`obj.declare`), or
 * member reads (`obj.declare`).
 */

import rule from "./no-declare-identifier";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-declare-identifier", rule, {
  valid: [
    // Look-alike name — must not match on substring.
    { code: `const declareResource = {};` },
    {
      code: `const declareToken = () => {}; declareToken.getContributions = 1;`,
    },
    // Property name / member read — `declare` as a key is legitimate.
    { code: `const o = { declare: 1 }; o.declare = 2;` },
    { code: `const x = obj.declare;` },
    // Renamed import binding.
    { code: `import { declare as decl } from "x"; decl();` },
  ],
  invalid: [
    {
      code: `const declare = {};`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `let declare = 1;`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `var declare = 1;`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `function declare() {}`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `class declare {}`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `const f = (declare) => declare;`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `import { declare } from "x";`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `const { declare } = obj;`,
      errors: [{ messageId: "bannedBinding" }],
    },
    {
      code: `try {} catch (declare) {}`,
      errors: [{ messageId: "bannedBinding" }],
    },
  ],
});
