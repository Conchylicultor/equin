/** Tests for `no-unlisted-timer`: any `defineTimer(...)` call is reported (the
 * exempt files are declared by their owning plugins' `exempt/index.ts`). */

import rule from "./no-unlisted-timer";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-unlisted-timer", rule, {
  valid: [
    { code: `defineJob({ name: "x" });` },
    { code: `const defineTimerLike = 1; defineTimerIn(spec, runtime);` },
    { code: `import { defineTimer } from "x"; export { defineTimer };` },
  ],
  invalid: [
    {
      code: `defineTimer({ name: "x", everyMs: 1000, run });`,
      errors: [{ messageId: "unlistedTimer" }],
    },
    {
      code: `timers.defineTimer({ name: "x", everyMs: 1000, run });`,
      errors: [{ messageId: "unlistedTimer" }],
    },
  ],
});
