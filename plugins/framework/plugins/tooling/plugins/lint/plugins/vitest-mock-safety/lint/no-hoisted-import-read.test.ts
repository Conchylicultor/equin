/**
 * Tests for `no-hoisted-import-read`: a `vi.hoisted` / `vi.mock` callback that
 * reads an imported value when it runs is reported; type-only reads, reads in
 * functions it only defines, `vitest`'s own names and non-hoisted calls are not.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-hoisted-import-read";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

ruleTester.run(
  "no-hoisted-import-read",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Imported inside the callback.
      `import { vi } from "vitest";
       const r = await vi.hoisted(async () => { const { ID } = await vi.importActual("@plugins/n/core"); return { id: ID }; });`,
      // Type-only reads are erased.
      `import type * as Core from "@plugins/c/core";
       import { vi } from "vitest";
       vi.mock("@plugins/c/core", async (orig) => ({ ...(await orig<typeof Core>()) }));`,
      `import { type Row, vi } from "vitest";
       import { type Item } from "@plugins/c/core";
       const s = vi.hoisted(() => ({ rows: [] as Item[] }));`,
      // A function the factory only defines runs later, after the imports.
      `import { Bar } from "./bar";
       import { vi } from "vitest";
       vi.mock("@plugins/x/web", async (orig) => ({ ...(await orig()), Foo: () => <Bar /> }));`,
      // Not hoisted.
      `import { X } from "./x";
       import { vi } from "vitest";
       vi.doMock("@plugins/x/web", () => ({ X }));`,
      // A hoisted local, not an import.
      `import { vi } from "vitest";
       const state = vi.hoisted(() => ({ n: 1 }));
       vi.mock("../x", () => ({ read: () => state.n, s: state }));`,
    ],
    invalid: [
      {
        code: `import { vi } from "vitest";
               import { MAIN_ID } from "@plugins/n/core";
               const registry = vi.hoisted(() => ({ composition: { id: MAIN_ID } }));`,
        errors: [{ messageId: "hoistedImportRead" }],
      },
      {
        code: `import { vi } from "vitest";
               import { Bar } from "./bar";
               vi.mock("../x", () => ({ el: <Bar /> }));`,
        errors: [{ messageId: "hoistedImportRead" }],
      },
      {
        code: `import { vi } from "vitest";
               import * as path from "node:path";
               vi.mock("../x", () => ({ root: path.join("a", "b") }));`,
        errors: [{ messageId: "hoistedImportRead" }],
      },
    ],
  },
);
