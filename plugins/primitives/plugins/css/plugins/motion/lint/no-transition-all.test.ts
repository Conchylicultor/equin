/**
 * Tests for the `no-transition-all` lint rule: a `transition-all` class token
 * is flagged in a string or template literal, with or without a variant
 * prefix; named transitions and look-alike tokens are not.
 */

import rule from "./no-transition-all";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

const error = [{ messageId: "transitionAll" as const }];

// `RuleTester.run` registers bun:test cases, so it runs at module top level.
ruleTester.run("no-transition-all", rule, {
  valid: [
    `const a = <div className="transition-colors duration-150" />;`,
    `const a = cn("transition-[color,opacity]", open && "opacity-100");`,
    `const a = "transition-all-but-not";`,
    `const a = "no-transition-allowed";`,
    // Prose quoting the class, not a class string.
    "const a = 'avoid `transition-all` here';",
    // A comment naming it is prose, not a class.
    `// every transition-all control\nconst a = 1;`,
  ],
  invalid: [
    {
      code: `const a = <div className="w-4 transition-all ease-linear" />;`,
      errors: error,
    },
    {
      code: `const a = cn("transition-all", open ? "w-auto" : "w-0");`,
      errors: error,
    },
    { code: `const a = "hover:transition-all";`, errors: error },
    { code: "const a = `px-2 transition-all`;", errors: error },
  ],
});
