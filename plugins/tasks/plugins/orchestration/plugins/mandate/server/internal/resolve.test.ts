import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineCapability,
  MandatePolicySchema,
  mandatePolicy,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { grantIn } from "./resolve";

const level = defineCapability<"low" | "high">({
  id: "test.level",
  schema: z.enum(["low", "high"]),
  label: "Level",
});

describe("grantIn", () => {
  test("a granted capability reads its parsed value", () => {
    expect(grantIn(level, mandatePolicy([level.grant("high")]), "root")).toBe(
      "high",
    );
  });

  test("a capability the policy does not grant reads null", () => {
    expect(grantIn(level, mandatePolicy([]), "below")).toBeNull();
  });

  test("an invalid stored value throws — never read as 'not granted'", () => {
    // A row written by other code: the column decoder only checks the shape
    // of the record, the capability's own schema checks the value.
    const stored = MandatePolicySchema.parse({ "test.level": "medium" });
    expect(() => grantIn(level, stored, "root")).toThrow(
      /"test\.level" holds an invalid value/,
    );
  });

  test("a scoped grant covers only the conversations at its scope", () => {
    const policy = mandatePolicy([], {
      root: [level.grant("low")],
      below: [level.grant("high")],
    });
    expect(grantIn(level, policy, "root")).toBe("low");
    expect(grantIn(level, policy, "below")).toBe("high");
    const rootOnly = mandatePolicy([], { root: [level.grant("low")] });
    expect(grantIn(level, rootOnly, "below")).toBeNull();
  });

  test("a whole-tree grant covers both scopes", () => {
    const policy = mandatePolicy([level.grant("high")]);
    expect(grantIn(level, policy, "root")).toBe("high");
    expect(grantIn(level, policy, "below")).toBe("high");
  });

  test("a stored policy granting a cap both whole-tree and scoped throws", () => {
    const stored = MandatePolicySchema.parse({
      "test.level": "low",
      "@below": { "test.level": "high" },
    });
    expect(() => grantIn(level, stored, "below")).toThrow(/both/);
  });
});
