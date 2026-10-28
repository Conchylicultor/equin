import { test, expect } from "bun:test";
import { z } from "zod";
import { defineFieldType } from "./define";
import { defineDefaultlessField, FieldDefaultError } from "./define-field";
import { fieldDefaults } from "./field-defaults";
import type { FieldDef } from "./field-spec";

const textType = defineFieldType<string>("__fd_text__");
const idType = defineFieldType<string>("__fd_id__");

const text: FieldDef<string> = Object.freeze({
  type: textType,
  schema: z.string(),
  defaultValue: "x",
  meta: {},
});
const id = defineDefaultlessField<string>({
  type: idType,
  schema: z.string(),
  meta: {},
});

test("fieldDefaults seeds every field at its default", () => {
  expect(fieldDefaults({ a: text }, "test")).toEqual({ a: "x" });
});

test("fieldDefaults names the composer and the key of a defaultless field", () => {
  expect(() => fieldDefaults({ a: text, id }, "objectField")).toThrow(
    FieldDefaultError,
  );
  expect(() => fieldDefaults({ a: text, id }, "objectField")).toThrow(
    /objectField: field "id" \(type "__fd_id__"\) has no default/,
  );
});
