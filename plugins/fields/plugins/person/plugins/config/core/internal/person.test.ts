import { test, expect } from "bun:test";
import { nullable } from "@plugins/fields/core";
import { personField } from "./person";

test("personField carries the person token, a string schema and an empty default", () => {
  const f = personField({ label: "L" });
  expect(f.type.id).toBe("person");
  expect(f.schema.parse("abc")).toBe("abc");
  expect(() => f.schema.parse(3)).toThrow();
  expect(f.defaultValue).toBe("");
  expect(f.meta.label).toBe("L");
});

test("personField declares an explicit default", () => {
  const f = personField({ default: "x" });
  expect(f.defaultValue).toBe("x");
  expect(f.defaultDeclared).toBe(true);
});

test("nullable(personField) keeps the token and accepts null", () => {
  const f = nullable(personField({ label: "L" }));
  expect(f.type.id).toBe("person");
  expect(f.schema.parse(null)).toBeNull();
});
