import { describe, expect, test } from "bun:test";
import { requestConfigChanges, type RequestConfig } from "./request-config";

const base: RequestConfig = {
  model: "model-a",
  effort: "medium",
  thinking: "adaptive",
  maxTokens: 128000,
  permissionMode: "auto",
  betas: ["a", "b"],
  shapeHash: "s1",
};

describe("requestConfigChanges", () => {
  test("identical settings have no changes", () => {
    expect(requestConfigChanges(base, { ...base, betas: ["a", "b"] })).toEqual(
      [],
    );
  });

  test("lists scalar, beta and shape changes in display order", () => {
    expect(
      requestConfigChanges(base, {
        ...base,
        model: "model-b",
        effort: undefined,
        betas: ["b", "c"],
        shapeHash: "s2",
      }),
    ).toEqual([
      { field: "model", from: "model-a", to: "model-b" },
      { field: "effort", from: "medium", to: undefined },
      { field: "betas", added: ["c"], removed: ["a"] },
      { field: "shape" },
    ]);
  });

  test("beta order alone is not a change", () => {
    expect(requestConfigChanges(base, { ...base, betas: ["b", "a"] })).toEqual(
      [],
    );
  });
});
