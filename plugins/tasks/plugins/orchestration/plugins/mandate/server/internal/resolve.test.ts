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
    expect(grantIn(level, mandatePolicy([level.grant("high")]))).toBe("high");
  });

  test("a capability the policy does not grant reads null", () => {
    expect(grantIn(level, mandatePolicy([]))).toBeNull();
  });

  test("an invalid stored value throws — never read as 'not granted'", () => {
    // A row written by other code: the column decoder only checks the shape
    // of the record, the capability's own schema checks the value.
    const stored = MandatePolicySchema.parse({ "test.level": "medium" });
    expect(() => grantIn(level, stored)).toThrow(
      /"test\.level" holds an invalid value/,
    );
  });
});
