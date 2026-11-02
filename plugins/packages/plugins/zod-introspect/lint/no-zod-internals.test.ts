/**
 * Tests for `no-zod-internals`: every internal read form is reported; the
 * public API (`ZodError`, schema-building, a zod type in a type position) is
 * not.
 */

import rule from "./no-zod-internals";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const FILE = "/repo/plugins/foo/core/schema.ts";

ruleTester.run("no-zod-internals", rule, {
  valid: [
    { code: `const s = z.string().min(1);`, filename: FILE },
    { code: `if (err instanceof ZodError) throw err;`, filename: FILE },
    { code: `if (err instanceof z.ZodError) throw err;`, filename: FILE },
    { code: `let s: z.ZodString;`, filename: FILE },
    { code: `const t = node.typeName;`, filename: FILE },
    { code: `if (x instanceof Zodiac) {}`, filename: FILE },
    { code: `const n = "ZodType";`, filename: FILE },
    { code: `const d = schema.def;`, filename: FILE },
  ],
  invalid: [
    {
      code: `const k = schema._def.typeName;`,
      filename: FILE,
      errors: [{ messageId: "internalKey" }],
    },
    {
      code: `const k = schema._zod.def.type;`,
      filename: FILE,
      errors: [{ messageId: "internalKey" }],
    },
    {
      code: `const k = schema["_def"];`,
      filename: FILE,
      errors: [{ messageId: "internalKey" }],
    },
    {
      code: `const { _def } = schema;`,
      filename: FILE,
      errors: [{ messageId: "internalKey" }],
    },
    {
      code: `if (s instanceof z.ZodString) {}`,
      filename: FILE,
      errors: [{ messageId: "zodInstanceof" }],
    },
    {
      code: `if (s instanceof ZodEffects) {}`,
      filename: FILE,
      errors: [{ messageId: "zodInstanceof" }],
    },
    {
      code: `const isArr = kind === "ZodArray";`,
      filename: FILE,
      errors: [{ messageId: "zodKind" }],
    },
    {
      code: "const isArr = kind === `ZodOptional`;",
      filename: FILE,
      errors: [{ messageId: "zodKind" }],
    },
    {
      code: `const k = z.ZodFirstPartyTypeKind.ZodString;`,
      filename: FILE,
      errors: [{ messageId: "zodKind" }],
    },
  ],
});
