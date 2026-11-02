/**
 * Tests for `partial-barrel-mock`: a factory mock of a `@plugins/` barrel must
 * spread its `importOriginal`; relative modules, non-factory mocks and other
 * calls are left alone.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./partial-barrel-mock";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

ruleTester.run(
  "partial-barrel-mock",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      `vi.mock("@plugins/x/web", async (importOriginal) => ({ ...(await importOriginal()), a: 1 }));`,
      `vi.mock("@plugins/x/web", async (orig) => { const real = await orig(); return { ...real, a: 1 }; });`,
      // The suite's own module: its author edits both sides.
      `vi.mock("../hooks/use-x", () => ({ useX: () => 1 }));`,
      // Not a plugin barrel.
      `vi.mock("@composition-web-registry", () => registry);`,
      // Automock / spy forms keep the real names.
      `vi.mock("@plugins/x/web");`,
      `vi.mock("@plugins/x/web", { spy: true });`,
      `other.mock("@plugins/x/web", () => ({}));`,
    ],
    invalid: [
      {
        code: `vi.mock("@plugins/x/web", () => ({ useLive: () => 1 }));`,
        errors: [{ messageId: "replacing" }],
      },
      {
        // A declared but unused original is still a replacement.
        code: `vi.mock("@plugins/x/web", async (importOriginal) => ({ a: 1 }));`,
        errors: [{ messageId: "replacing" }],
      },
      {
        code: `vi.doMock("@plugins/x/core", function () { return {}; });`,
        errors: [{ messageId: "replacing" }],
      },
    ],
  },
);
