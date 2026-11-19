import rule from "./no-time-origin-arithmetic";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-time-origin-arithmetic", rule, {
  valid: [
    // When the realm started, on the wall clock: one reading, no arithmetic.
    { code: `const startedAt = Math.round(performance.timeOrigin);` },
    { code: `const since = new Date(performance.timeOrigin);` },
    { code: `const at = perfToEpoch(asPerfMs(e.startTime));` },
    { code: `const ms = Date.now() - startedAt;` },
  ],
  invalid: [
    {
      code: `const at = performance.timeOrigin + e.startTime;`,
      errors: [{ messageId: "arithmetic" }],
    },
    {
      code: `const t = frame.startedAt - performance.timeOrigin;`,
      errors: [{ messageId: "arithmetic" }],
    },
    {
      code: `const at = kept.timeOrigin + s.timestamp;`,
      errors: [{ messageId: "arithmetic" }],
    },
    {
      code: `const timeOrigin = performance.timeOrigin; const at = timeOrigin + s.timestamp;`,
      errors: [{ messageId: "arithmetic" }],
    },
    {
      code: `const at = (globalThis.performance.timeOrigin as number) + ev.timeStamp;`,
      errors: [{ messageId: "arithmetic" }],
    },
    {
      code: `const at = Math.round(performance.timeOrigin) + e.startTime;`,
      errors: [{ messageId: "arithmetic" }],
    },
    {
      code: `let at = ev.timeStamp; at += performance.timeOrigin;`,
      errors: [{ messageId: "arithmetic" }],
    },
  ],
});
