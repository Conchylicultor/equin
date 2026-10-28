import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { inspect, peel } from "./inspect";
import type { SchemaNodeOf } from "./schema-node";
import { defineSchemaTag } from "./tag";

const bound = defineSchemaTag<{ max: number }>("test-bound");
const other = defineSchemaTag<string>("test-other");

describe("defineSchemaTag", () => {
  test("set returns a new schema; the source is untouched", () => {
    const source = z.array(z.string());
    const tagged = bound.set(source, { max: 3 });
    expect(tagged).not.toBe(source);
    expect(bound.get(tagged)).toEqual({ max: 3 });
    expect(bound.get(source)).toBeUndefined();
    expect(tagged.parse(["a"])).toEqual(["a"]);
  });

  test("a described source keeps no tag (a clone sharing its def)", () => {
    const source = z.array(z.string());
    const described = source.describe("d");
    const tagged = bound.set(described, { max: 1 });
    expect(bound.get(described)).toBeUndefined();
    expect(bound.get(source)).toBeUndefined();
    expect(bound.get(tagged)).toEqual({ max: 1 });
    expect(tagged.description).toBe("d");
  });

  test("survives .max(), .describe(), .refine()", () => {
    const tagged = bound.set(z.array(z.string()), { max: 3 });
    expect(bound.get(tagged.max(9))).toEqual({ max: 3 });
    expect(bound.get(tagged.describe("x"))).toEqual({ max: 3 });
    expect(bound.get(tagged.refine(() => true))).toEqual({ max: 3 });
    expect(bound.get(tagged.brand<"X">())).toEqual({ max: 3 });
  });

  test("reachable through wrappers, by walking their inner", () => {
    const tagged = bound.set(z.record(z.string(), z.number()), { max: 2 });
    const wrapped = tagged.optional().nullable().default({});
    expect(bound.get(wrapped)).toBeUndefined();
    expect(bound.get(peel(wrapped).node.schema)).toEqual({ max: 2 });
    const opt = inspect(tagged.optional()) as SchemaNodeOf<"optional">;
    expect(bound.get(opt.inner)).toEqual({ max: 2 });
  });

  test("tags are namespaced", () => {
    const both = other.set(bound.set(z.string(), { max: 1 }), "o");
    expect(bound.get(both)).toEqual({ max: 1 });
    expect(other.get(both)).toBe("o");
    expect(other.get(bound.set(z.string(), { max: 1 }))).toBeUndefined();
  });

  test("a tag on a refined schema", () => {
    const refined = z
      .record(z.string(), z.number())
      .superRefine(() => undefined);
    const tagged = bound.set(refined, { max: 4 });
    expect(bound.get(tagged)).toEqual({ max: 4 });
    expect(bound.get(refined)).toBeUndefined();
    expect(inspect(tagged).kind).toBe("record");
    expect(inspect(tagged).checks).toEqual([{ kind: "refine" }]);
  });

  test("get on a non-schema throws", () => {
    expect(() => bound.get({})).toThrow(/not a zod schema/);
    expect(() => bound.set({}, { max: 1 })).toThrow(/not a zod schema/);
  });
});

describe("defineSchemaTag — metadata", () => {
  test("survives .meta() and .check()", () => {
    const tagged = bound.set(z.array(z.string()), { max: 3 });
    expect(bound.get(tagged.meta({ title: "t" }))).toEqual({ max: 3 });
    expect(bound.get(tagged.check(() => undefined))).toEqual({ max: 3 });
  });

  test("carries registry metadata over to the clone", () => {
    const source = z.string().meta({ title: "T", description: "D" });
    const tagged = bound.set(source, { max: 1 });
    expect(tagged.meta()).toEqual({ title: "T", description: "D" });
  });

  test("an empty name is refused", () => {
    expect(() => defineSchemaTag("")).toThrow(/empty tag name/);
  });
});

describe("a tagged default", () => {
  const tag = defineSchemaTag<string>("test.tagged-default");

  test("still makes a fresh fill per parse", () => {
    const tagged = tag.set(z.array(z.string()).default([]), "x") as z.ZodType<
      string[]
    >;
    expect(tagged.parse(undefined)).not.toBe(tagged.parse(undefined));
    let n = 0;
    const counted = tag.set(
      z.number().default(() => ++n),
      "x",
    ) as z.ZodType<number>;
    expect(counted.parse(undefined)).not.toBe(counted.parse(undefined));
  });
});
