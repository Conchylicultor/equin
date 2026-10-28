/**
 * Tests for `no-zod-subpath`: every module-naming form of a `zod/…` specifier
 * is reported; `"zod"` itself and look-alike packages are not.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-zod-subpath";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const FILE = "/repo/plugins/foo/core/schema.ts";
const error = (specifier: string) => ({
  messageId: "zodSubpath" as const,
  data: { specifier },
});

ruleTester.run(
  "no-zod-subpath",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      { code: `import { z } from "zod";`, filename: FILE },
      { code: `import type { ZodType } from "zod";`, filename: FILE },
      { code: `export { z } from "zod";`, filename: FILE },
      { code: `const m = await import("zod");`, filename: FILE },
      { code: `import { x } from "zod-to-json-schema";`, filename: FILE },
      { code: `import { x } from "@scope/zod/v4";`, filename: FILE },
      { code: `const s = "zod/v4";`, filename: FILE },
    ],
    invalid: [
      ...["zod/v3", "zod/v4", "zod/v4/core", "zod/v4/mini", "zod/mini"].map(
        (specifier) => ({
          code: `import * as z from "${specifier}";`,
          filename: FILE,
          errors: [error(specifier)],
        }),
      ),
      {
        code: `import type * as core from "zod/v4/core";`,
        filename: FILE,
        errors: [error("zod/v4/core")],
      },
      {
        code: `export { z } from "zod/v4";`,
        filename: FILE,
        errors: [error("zod/v4")],
      },
      {
        code: `export * from "zod/v3";`,
        filename: FILE,
        errors: [error("zod/v3")],
      },
      {
        code: `const m = await import("zod/v4");`,
        filename: FILE,
        errors: [error("zod/v4")],
      },
      {
        code: `const m = require("zod/v4");`,
        filename: FILE,
        errors: [error("zod/v4")],
      },
      {
        code: `type T = typeof import("zod/v4");`,
        filename: FILE,
        errors: [error("zod/v4")],
      },
      {
        code: `import z = require("zod/v4");`,
        filename: FILE,
        errors: [error("zod/v4")],
      },
      // Test files are not exempt.
      {
        code: `import * as z4 from "zod/v4";`,
        filename: "/repo/plugins/foo/core/schema.test.ts",
        errors: [error("zod/v4")],
      },
    ],
  },
);
