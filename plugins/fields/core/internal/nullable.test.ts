import { test, expect } from "bun:test";
import { z } from "zod";
import { inspect } from "@plugins/packages/plugins/zod-introspect/core";
import { nullable } from "./nullable";
import { fieldsToZodObject } from "./schema-builder";
import type { FieldDef } from "./field-spec";
import type { FieldType } from "./types";

// A throwaway non-null text-ish field (decoupled from the concrete factories).
const textType = { id: "text" } as FieldType<string>;
function textDef(): FieldDef<string> {
  return Object.freeze({
    type: textType,
    schema: z.string(),
    defaultValue: "",
    meta: {},
  });
}

test("nullable() preserves the type token (storage keying is unchanged)", () => {
  expect(nullable(textDef()).type.id).toBe("text");
});

test("nullable() makes the schema ZodNullable and defaults to null", () => {
  const n = nullable(textDef());
  expect(inspect(n.schema).kind).toBe("nullable");
  expect(n.defaultValue).toBe(null);
  // Accepts both a value and null.
  expect(n.schema.parse("hi")).toBe("hi");
  expect(n.schema.parse(null)).toBe(null);
});

test("nullable() field heals a missing key to null via fieldsToZodObject", () => {
  const obj = fieldsToZodObject({ name: nullable(textDef()) });
  expect(obj.parse({}).name).toBe(null);
  expect(obj.parse({ name: "x" }).name).toBe("x");
});
