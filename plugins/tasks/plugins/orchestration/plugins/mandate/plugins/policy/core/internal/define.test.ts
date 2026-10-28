import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineCapability, mandatePolicy } from "./define";

const flag = defineCapability<true>({
  id: "test.flag",
  schema: z.literal(true),
  label: "Flag",
});
const level = defineCapability<"low" | "high">({
  id: "test.level",
  schema: z.enum(["low", "high"]),
  label: "Level",
});

describe("mandatePolicy", () => {
  test("records one entry per grant, keyed by capability id", () => {
    expect(mandatePolicy([flag.grant(true), level.grant("high")])).toEqual({
      "test.flag": true,
      "test.level": "high",
    } as never);
  });

  test("granting a capability twice throws", () => {
    expect(() =>
      mandatePolicy([level.grant("low"), level.grant("high")]),
    ).toThrow(/"test\.level" granted twice/);
  });

  test("an empty policy grants nothing", () => {
    expect(mandatePolicy([])).toEqual({} as never);
  });
});

describe("Capability.grant", () => {
  test("a value its schema refuses throws at the author", () => {
    // A value laundered past tsc (a cast, a config read) is caught here.
    expect(() => level.grant("medium" as "low")).toThrow();
  });
});
