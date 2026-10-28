import { test, expect } from "bun:test";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { uuidField } from "@plugins/fields/plugins/uuid/plugins/config/core";
import { objectField } from "./object";

const UUID = "6f1c2c1e-3b8a-4c5e-9f00-0a1b2c3d4e5f";

test("with no default, the object's is seeded from its sub-fields'", () => {
  const f = objectField({ subFields: { name: textField({ default: "a" }) } });
  expect(f.defaultValue).toEqual({ name: "a" });
});

test("a defaultless sub-field needs the object's own default (tsc), and is required in it", () => {
  // @ts-expect-error — `id` has no default to seed the object's from.
  expect(() => objectField({ subFields: { id: uuidField() } })).toThrow(
    /objectField: field "id" .* has no default/,
  );
  const f = objectField({
    subFields: { id: uuidField() },
    default: { id: UUID },
  });
  expect(f.defaultValue).toEqual({ id: UUID });
  expect(f.schema.safeParse({}).success).toBe(false);
});
