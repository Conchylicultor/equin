import { describe, expect, test } from "bun:test";
import { defineMetric, defineMetricSource } from "./define-metric";
import {
  bool,
  enumOf,
  paramSpecsToWire,
  parseParams,
  stringList,
} from "./params";

const specs = {
  repoOnly: bool(true),
  granularity: enumOf(["file", "dir"], "file"),
  excluded: stringList(["vendor/"]),
};

describe("parseParams", () => {
  test("a missing param takes its default", () => {
    expect(parseParams(specs, {})).toEqual({
      ok: true,
      values: {
        repoOnly: true,
        granularity: "file",
        excluded: ["vendor/"],
      },
    });
  });

  test("given values are kept", () => {
    const r = parseParams(specs, {
      repoOnly: false,
      granularity: "dir",
      excluded: ["a", "b"],
    });
    expect(r).toEqual({
      ok: true,
      values: {
        repoOnly: false,
        granularity: "dir",
        excluded: ["a", "b"],
      },
    });
  });

  test.each([
    ["an unknown name", { nope: 1 }, /unknown param "nope"/],
    ["a non-boolean", { repoOnly: "yes" }, /repoOnly.*boolean/],
    [
      "a value outside the enum",
      { granularity: "line" },
      /granularity.*one of/,
    ],
    ["a list of non-strings", { excluded: [1] }, /excluded.*list of strings/],
    [
      "a bare string for a list",
      { excluded: "a" },
      /excluded.*list of strings/,
    ],
  ])("%s is an error", (_name, raw, message) => {
    const r = parseParams(specs, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  test("a default list is copied, never shared", () => {
    const a = parseParams(specs, {});
    if (!a.ok) throw new Error("unreachable");
    a.values.excluded.push("x");
    const b = parseParams(specs, {});
    if (!b.ok) throw new Error("unreachable");
    expect(b.values.excluded).toEqual(["vendor/"]);
  });
});

describe("specs", () => {
  test("an enum default must be one of its values", () => {
    expect(() => enumOf(["a", "b"], "c" as "a")).toThrow(/not one of/);
  });

  test("the wire form names each spec", () => {
    expect(paramSpecsToWire(specs)).toEqual([
      { id: "repoOnly", kind: "bool", default: true },
      {
        id: "granularity",
        kind: "enum",
        values: ["file", "dir"],
        default: "file",
      },
      { id: "excluded", kind: "stringList", default: ["vendor/"] },
    ]);
  });
});

describe("declarations", () => {
  const src = defineMetricSource({ id: "cost", label: "Spend", params: specs });

  test("a metric's global id is <source>.<id>, and its declaration is frozen", () => {
    const m = defineMetric(src, {
      id: "spend",
      label: "Spend",
      unit: "usd",
      polarity: "down",
      measure: "flow",
      params: ["repoOnly"],
    });
    expect(m.id).toBe("cost.spend");
    expect(m.params).toEqual(["repoOnly"]);
    expect(Object.isFrozen(m)).toBe(true);
  });

  test("a metric may only read its source's params", () => {
    expect(() =>
      defineMetric(src, {
        id: "spend",
        label: "Spend",
        unit: "usd",
        polarity: "down",
        measure: "flow",
        // @ts-expect-error — not a param of the source
        params: ["nope"],
      }),
    ).toThrow(/not declared by source "cost"/);
  });

  test("ids carry no dot, and split ids are unique", () => {
    expect(() => defineMetricSource({ id: "a.b", label: "x" })).toThrow(
      /no dots/,
    );
    expect(() =>
      defineMetric(src, {
        id: "m",
        label: "M",
        unit: "count",
        polarity: "up",
        measure: "flow",
        splits: [
          { id: "s", label: "S" },
          { id: "s", label: "S again" },
        ],
      }),
    ).toThrow(/split id is declared twice/);
  });
});
