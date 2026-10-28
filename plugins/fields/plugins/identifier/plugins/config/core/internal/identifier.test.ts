import { test, expect } from "bun:test";
import { nullable } from "@plugins/fields/core";
import { identifierField } from "./identifier";

test("identifierField carries the identifier token, a string schema and an empty default", () => {
  const f = identifierField({ label: "L" });
  expect(f.type.id).toBe("identifier");
  expect(f.schema.parse("abc")).toBe("abc");
  expect(() => f.schema.parse(3)).toThrow();
  expect(f.defaultValue).toBe("");
  expect(f.meta.label).toBe("L");
});

test("identifierField declares an explicit default", () => {
  const f = identifierField({ default: "x" });
  expect(f.defaultValue).toBe("x");
  expect(f.defaultDeclared).toBe(true);
});

test("nullable(identifierField) keeps the token and accepts null", () => {
  const f = nullable(identifierField({ label: "L" }));
  expect(f.type.id).toBe("identifier");
  expect(f.schema.parse(null)).toBeNull();
});
