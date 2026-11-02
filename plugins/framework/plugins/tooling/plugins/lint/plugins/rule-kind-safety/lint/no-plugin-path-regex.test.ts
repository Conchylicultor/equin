/**
 * Tests for the `no-plugin-path-regex` lint rule: in a lint rule's own source, a
 * regex (literal or `new RegExp("…")`) naming one plugin by its path is flagged;
 * generic folder grammar, plain strings and files outside `lint/` are not.
 */

import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-plugin-path-regex";

const ruleTester = createRuleTester();
const RULE = "/repo/plugins/a/plugins/b/lint/rule.ts";
const regex = [{ messageId: "regex" }];

ruleTester.run("no-plugin-path-regex", rule, {
  valid: [
    // The located spellings.
    {
      code: `const SOURCE = "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";`,
      filename: RULE,
    },
    {
      code: `const DIR = "plugins/framework/plugins/tooling/plugins/checks/core";`,
      filename: RULE,
    },
    // Folder grammar names no plugin.
    {
      code: `const CHECK = /(?:^|\\/)plugins\\/(?:[^/]+\\/plugins\\/)*[^/]+\\/check\\//;`,
      filename: RULE,
    },
    { code: `const NAMED = /\\/plugins\\/check\\//;`, filename: RULE },
    { code: `const WEB = /(?:^|\\/)plugins\\/.*\\/web\\//;`, filename: RULE },
    // A bare prefix names no plugin.
    { code: `const ANY = /^@plugins\\/[^/]+/;`, filename: RULE },
    // Outside a rule's source the rule does not apply.
    {
      code: `const RE = /^@plugins\\/ui\\/plugins\\/icons\\/web$/;`,
      filename: "/repo/plugins/a/core/x.ts",
    },
    {
      code: `const RE = /^@plugins\\/ui\\/plugins\\/icons\\/web$/;`,
      filename: "/repo/plugins/a/plugins/lint/core/x.ts",
    },
  ],
  invalid: [
    // The dead guard's spellings, verbatim.
    {
      code: `const RE = /^@plugins\\/primitives\\/plugins\\/floating-surface\\/web$/;`,
      filename: RULE,
      errors: regex,
    },
    {
      code: `const RE = /text-editor\\/plugins\\/caret-trigger\\/web$/;`,
      filename: RULE,
      errors: regex,
    },
    // A path pattern rots the same way.
    {
      code: `const RE = /(?:^|\\/)plugins\\/framework\\/plugins\\/tooling\\/plugins\\/checks\\/core\\//;`,
      filename: RULE,
      errors: regex,
    },
    {
      code: `const RE = new RegExp("^@plugins/ui/plugins/icons/web$");`,
      filename: RULE,
      errors: regex,
    },
  ],
});
