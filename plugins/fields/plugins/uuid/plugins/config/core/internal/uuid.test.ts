import { test, expect } from "bun:test";
import { fieldsToZodObject } from "@plugins/fields/core";
import { uuidField } from "./uuid";

const UUID = "6f1c2c1e-3b8a-4c5e-9f00-0a1b2c3d4e5f";

test("a uuid field with no default has none: its key is required", () => {
  const id = uuidField({ label: "Id" });
  expect(id.defaultless).toBe(true);
  expect(id.meta.label).toBe("Id");
  const schema = fieldsToZodObject({ id });
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.parse({ id: UUID })).toEqual({ id: UUID });
});

test("a declared uuid default backfills and is marked declared", () => {
  const id = uuidField({ default: UUID });
  expect(id.defaultDeclared).toBe(true);
  expect(fieldsToZodObject({ id }).parse({})).toEqual({ id: UUID });
});

test("a declared default that is not a uuid fails at definition", () => {
  expect(() => uuidField({ default: "" })).toThrow(/"uuid"/);
});
