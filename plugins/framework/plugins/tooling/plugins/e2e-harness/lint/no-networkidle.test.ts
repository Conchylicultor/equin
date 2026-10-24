/**
 * Tests for the `no-networkidle` lint rule. Run with `./equin test`.
 *
 * The rule bans the `"networkidle"` literal in e2e scripts only — server-side
 * Playwright renderers of other pages keep it.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-networkidle";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const E2E = `${process.cwd()}/plugins/demo/e2e/flow.ts`;
const SERVER = `${process.cwd()}/plugins/demo/server/internal/render.ts`;

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-networkidle",
  rule as unknown as Parameters<typeof ruleTester.run>[1],
  {
    valid: [
      { code: `await waitForNetworkIdle(page);`, filename: E2E },
      { code: `await page.waitForLoadState("load");`, filename: E2E },
      // A server-side renderer of another page may use it.
      { code: `await page.waitForLoadState("networkidle");`, filename: SERVER },
    ],
    invalid: [
      {
        code: `await page.waitForLoadState("networkidle");`,
        filename: E2E,
        errors: [{ messageId: "networkidle" }],
      },
      {
        code: `await page.goto(url, { waitUntil: "networkidle" });`,
        filename: E2E,
        errors: [{ messageId: "networkidle" }],
      },
    ],
  },
);
