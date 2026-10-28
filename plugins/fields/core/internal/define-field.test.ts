import { test, expect } from "bun:test";
import { z } from "zod";
import { defineFieldType } from "./define";
import {
  defineDefaultlessField,
  defineField,
  FieldDefaultError,
} from "./define-field";
import type { FieldDef } from "./field-spec";
import { nullable } from "./nullable";
import { fieldSchemaWithDefault, fieldsToZodObject } from "./schema-builder";

const intType = defineFieldType<number>("__df_int__");
const idType = defineFieldType<string>("__df_id__");

test("defineField refuses a default its own schema rejects, naming the type and the issue", () => {
  expect(() =>
    defineField({
      type: intType,
      schema: z.number().int().min(1),
      defaultValue: 0,
      meta: {},
    }),
  ).toThrow(FieldDefaultError);
  expect(() =>
    defineField({
      type: intType,
      schema: z.number().int().min(1),
      defaultValue: 0,
      meta: {},
    }),
  ).toThrow(/"__df_int__".*\(root\)/);
});

test("defineField freezes and returns a field whose default parses", () => {
  const field = defineField({
    type: intType,
    schema: z.number().int(),
    defaultValue: 3,
    meta: {},
  });
  expect(Object.isFrozen(field)).toBe(true);
  expect(fieldsToZodObject({ n: field }).parse({})).toEqual({ n: 3 });
});

test("fieldSchemaWithDefault asserts a hand-frozen def that skipped defineField", () => {
  const bad: FieldDef<string> = Object.freeze({
    type: idType,
    schema: z.string().uuid(),
    defaultValue: "",
    meta: {},
  });
  expect(() => fieldSchemaWithDefault(bad)).toThrow(FieldDefaultError);
});

test("a defaultless field stays required, and reading its default throws", () => {
  const id = defineDefaultlessField({
    type: idType,
    schema: z.string().uuid(),
    meta: {},
  });
  const schema = fieldsToZodObject({ id });
  expect(schema.safeParse({}).success).toBe(false);
  const uuid = "6f1c2c1e-3b8a-4c5e-9f00-0a1b2c3d4e5f";
  expect(schema.parse({ id: uuid })).toEqual({ id: uuid });
  expect(() => id.defaultValue).toThrow(FieldDefaultError);
});

test("nullable() gives a defaultless field the null default", () => {
  const id = nullable(
    defineDefaultlessField({
      type: idType,
      schema: z.string().uuid(),
      meta: {},
    }),
  );
  expect(id.defaultless).toBeUndefined();
  expect(fieldsToZodObject({ id }).parse({})).toEqual({ id: null });
});
