import { describe, expect, test } from "bun:test";
import { requestConfigOf, slimApiRequestLine } from "./api-request";

const line = (params: Record<string, unknown>) => ({
  type: "api-request",
  timestamp: "2026-10-20T00:00:00.000Z",
  shapeHash: "abc",
  params,
});

const slimmed = (obj: Record<string, unknown>) => {
  const copy = structuredClone(obj);
  slimApiRequestLine(copy);
  return copy;
};

describe("slimApiRequestLine", () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "every field read",
      {
        model: "model-a",
        betas: ["a", "b", 3],
        max_tokens: 64000,
        output_config: { effort: "high", other: 1 },
        thinking: { type: "adaptive", budget: 1 },
        safeguards: [
          { classifier_context: { permission_mode: "bypassPermissions" } },
        ],
        messages: [{ role: "user", content: "x".repeat(10_000) }],
        system: [{ type: "text", text: "y".repeat(10_000) }],
      },
    ],
    ["only a model", { model: "model-b" }],
    [
      "malformed optional fields",
      {
        model: "m",
        betas: "not-an-array",
        max_tokens: "big",
        output_config: [],
        thinking: null,
        safeguards: [null, { classifier_context: "x" }, {}],
      },
    ],
  ];
  for (const [name, params] of cases) {
    test(`${name}: the config read is unchanged`, () => {
      const obj = line(params);
      expect(requestConfigOf(slimmed(obj))).toEqual(requestConfigOf(obj));
    });
  }

  test("the request body is dropped", () => {
    const obj = slimmed(line(cases[0]![1]));
    const json = JSON.stringify(obj);
    expect(json).not.toContain("x".repeat(100));
    expect(json).not.toContain("y".repeat(100));
  });

  test("a line the reader cannot read (no model) is left whole", () => {
    const obj = line({ messages: ["kept"] });
    expect(slimmed(obj)).toEqual(obj);
  });
});
