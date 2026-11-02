/**
 * Tests for `no-raw-set-interval`: every `setInterval` in server / central /
 * shared / bin code is reported — an inline `runTracked` wrapper no longer
 * earns a pass — while web code, tests and look-alikes are left alone.
 */

import rule from "./no-raw-set-interval";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const SERVER = "/repo/plugins/foo/server/internal/loop.ts";
const CENTRAL = "/repo/plugins/foo/central/internal/loop.ts";

ruleTester.run("no-raw-set-interval", rule, {
  valid: [
    // Browser code is out of scope.
    {
      code: `setInterval(tick, 1000);`,
      filename: "/repo/plugins/foo/web/a.ts",
    },
    // Tests are out of scope.
    {
      code: `setInterval(tick, 1000);`,
      filename: "/repo/plugins/foo/server/a.test.ts",
    },
    // Look-alikes.
    { code: `setTimeout(tick, 1000);`, filename: SERVER },
    { code: `const setIntervalMs = 5; clearInterval(h);`, filename: SERVER },
  ],
  invalid: [
    {
      code: `setInterval(tick, 1000);`,
      filename: SERVER,
      errors: [{ messageId: "rawSetInterval" }],
    },
    {
      // A wrapped callback used to pass; it no longer does.
      code: `setInterval(() => { void runTracked("x", tick); }, 1000);`,
      filename: SERVER,
      errors: [{ messageId: "rawSetInterval" }],
    },
    {
      code: `globalThis.setInterval(tick, 1000);`,
      filename: CENTRAL,
      errors: [{ messageId: "rawSetInterval" }],
    },
    {
      code: `setInterval(tick, 1000);`,
      filename: "/repo/plugins/foo/bin/index.ts",
      errors: [{ messageId: "rawSetInterval" }],
    },
  ],
});
