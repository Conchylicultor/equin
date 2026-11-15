import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineField, defineFieldType } from "@plugins/fields/core";
import { defineConfig } from "../core/internal/define-config";
import { configDefaultFailures } from "./config-defaults";
import type { ConfigRegistration } from "./config-registrations";

const reg = (descriptor: unknown): ConfigRegistration => ({
  runtime: "web",
  registrar: "config_v2",
  owner: "config_v2",
  storePath: "config_v2/config.jsonc",
  barrel: "plugins/config_v2/web/index.ts",
  descriptor,
});

const intType = defineFieldType<number>("__cd_int__");
const positive = (defaultValue: number) =>
  defineField({
    type: intType,
    schema: z.number().int().min(1),
    defaultValue,
    meta: {},
  });

describe("configDefaultFailures", () => {
  test("a descriptor whose defaults parse passes", () => {
    const d = defineConfig({ fields: { n: positive(2) } });
    expect(configDefaultFailures([reg(d), reg(d)])).toEqual([]);
  });

  test("a field default its schema rejects fails, naming the field type, though defineConfig did not throw", () => {
    const d = defineConfig({ fields: { n: positive(0) } });
    const failures = configDefaultFailures([reg(d)]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("config_v2/config.jsonc");
    expect(failures[0]).toContain('"__cd_int__"');
  });

  test("defineConfig composes its schema once, on first read", () => {
    const d = defineConfig({ fields: { n: positive(2) } });
    expect(d.schema).toBe(d.schema);
    expect(d.schema.parse({})).toEqual({ n: 2 });
  });

  test("a registration that is no descriptor fails", () => {
    expect(configDefaultFailures([reg({ name: "x" })])).toHaveLength(1);
  });
});
