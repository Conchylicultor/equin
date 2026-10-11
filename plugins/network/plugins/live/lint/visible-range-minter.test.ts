/**
 * Tests for the `visible-range-minter` lint rule: a paged read's viewport is
 * minted by data-view alone.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./visible-range-minter";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const minter = { messageId: "minter" as const };
const BARREL = "@plugins/network/plugins/live/web";

// `RuleTester.run` drives the test harness itself, so it runs at top level.
ruleTester.run(
  "visible-range-minter",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        code: `import { useLive, type VisibleRange } from "${BARREL}";`,
      },
      // Another module's export of the same name.
      { code: `import { mintVisibleRange } from "./visible-range";` },
      {
        code: `import * as live from "${BARREL}"; live.useLive(c, q, o);`,
      },
      // Not a namespace of the barrel.
      { code: `const live = other; live.mintVisibleRange(r);` },
    ],
    invalid: [
      {
        code: `import { mintVisibleRange } from "${BARREL}";`,
        errors: [minter],
      },
      {
        code: `import { mintVisibleRange as mint } from "${BARREL}";`,
        errors: [minter],
      },
      {
        code: `export { mintVisibleRange } from "${BARREL}";`,
        errors: [minter],
      },
      {
        code: `import * as live from "${BARREL}"; live.mintVisibleRange(r);`,
        errors: [minter],
      },
      {
        code: `import * as live from "${BARREL}"; live["mintVisibleRange"](r);`,
        errors: [minter],
      },
    ],
  },
);
