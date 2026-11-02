/**
 * Tests for the `no-unroute` lint rule. Run with `bun test`.
 *
 * The rule bans tearing down a Playwright route that may still be running:
 * `unroute()` unconditionally, and `unrouteAll()` only when it does not pass an
 * explicit `behavior` (its default does not wait for handlers in flight).
 *
 * The valid cases pin the two boundaries that keep this from being noise: a
 * method merely NAMED `route` is untouched (the change-feed's `opts.route(…)`
 * is a real call site), and `unrouteAll` with a deliberate `behavior` is the
 * sanctioned escape hatch.
 */

import rule from "./no-unroute";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run(
  "no-unroute",
  rule as unknown as Parameters<typeof ruleTester.run>[1],
  {
    valid: [
      // Registering a route is fine — the hazard is the teardown, not the setup.
      { code: `await page.route("**/api/x", handler);` },
      // An unrelated method that happens to be named `route`.
      { code: `opts.route({ table, op: "U" });` },
      { code: `const next = router.route(request);` },
      // An explicit behavior is a deliberate choice about handlers in flight.
      { code: `await page.unrouteAll({ behavior: "wait" });` },
      { code: `await page.unrouteAll({ behavior: "ignoreErrors" });` },
      { code: `await context.unrouteAll({ "behavior": "wait" });` },
    ],
    invalid: [
      {
        code: `await page.unroute("**/api/x");`,
        errors: [{ messageId: "unroute" }],
      },
      {
        code: `await page.unroute("**/api/x", handler);`,
        errors: [{ messageId: "unroute" }],
      },
      {
        code: `await context.unroute("**/api/x");`,
        errors: [{ messageId: "unroute" }],
      },
      {
        code: `await page.unrouteAll();`,
        errors: [{ messageId: "unrouteAllDefault" }],
      },
      // An options object without `behavior` is still the unsafe default.
      {
        code: `await page.unrouteAll({});`,
        errors: [{ messageId: "unrouteAllDefault" }],
      },
    ],
  },
);
