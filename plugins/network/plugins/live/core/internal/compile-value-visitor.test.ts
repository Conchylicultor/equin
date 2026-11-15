/**
 * `visitorTuple` is paired with the declaration (compile-value's
 * `visitorTupleOf`): a parameterized value granting `access: { visitor }` must
 * say which tuples a visitor reads, and nothing else may say it — so a new
 * parameterized visitor value cannot open every tuple by omission.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { compileValue } from "./compile-value";

let seq = 0;
const key = (name: string) => `test.compile-value-visitor.${name}.${seq++}`;
const VISITOR = { visitor: "the test page reads it" };
const base = {
  source: "external",
  changes: { fixed: { reason: "a test constant" } },
  loader: () => "x",
} as const;

describe("visitorTuple", () => {
  test("a parameterized visitor value without it throws, naming both spellings", () => {
    const v = liveValue(key("missing"), {
      schema: z.string(),
      params: ["path"],
      access: VISITOR,
    });
    expect(() => compileValue(v, base)).toThrow(/visitorTuple/);
  });

  test("a predicate becomes the runtime's per-tuple rule", async () => {
    const v = liveValue(key("predicate"), {
      schema: z.string(),
      params: ["path"],
      access: VISITOR,
    });
    const c = compileValue(v, {
      ...base,
      visitorTuple: ({ path }, { webPlugins }) =>
        path === "ok" && webPlugins.has("site"),
    });
    const rule = c.options.visitorTuple!;
    const site = { webPlugins: new Set(["site"]) };
    expect(await rule({ path: "ok" }, site)).toBe(true);
    expect(await rule({ path: "no" }, site)).toBe(false);
    expect(await rule({ path: "ok" }, { webPlugins: new Set() })).toBe(false);
  });

  test("{ every } opens every tuple (no rule beside the whole-resource access)", () => {
    const v = liveValue(key("every"), {
      schema: z.string(),
      params: ["path"],
      access: VISITOR,
    });
    const c = compileValue(v, {
      ...base,
      visitorTuple: { every: "public assets" },
    });
    expect(c.options.visitorTuple).toBeUndefined();
  });

  test("an empty { every } reason throws", () => {
    const v = liveValue(key("empty"), {
      schema: z.string(),
      params: ["path"],
      access: VISITOR,
    });
    expect(() =>
      compileValue(v, { ...base, visitorTuple: { every: " " } }),
    ).toThrow(/visitorTuple/);
  });

  test("on an owner-only value, or a param-less one, it is refused", () => {
    const owner = liveValue(key("owner"), {
      schema: z.string(),
      params: ["path"],
    });
    expect(() =>
      compileValue(owner, { ...base, visitorTuple: () => true }),
    ).toThrow(/grants visitors nothing/);
    const single = liveValue(key("single"), {
      schema: z.string(),
      access: VISITOR,
    });
    expect(() =>
      compileValue(single, { ...base, visitorTuple: () => true }),
    ).toThrow(/one tuple/);
    // A param-less visitor value needs none.
    expect(() => compileValue(single, base)).not.toThrow();
  });
});
