import { describe, expect, test } from "bun:test";
import { StallSectionSchema, type StallSection } from "../../core";
import { stallClass } from "./class";

const section: StallSection = {
  nSamples: 200,
  sampleRateHz: 230,
  topLeaves: [{ key: "buildPluginTree @ x/tree.ts:120", count: 120, pct: 60 }],
  topStacks: [{ stack: "buildPluginTree ← scanDir", count: 120, pct: 60 }],
};

describe("stallClass", () => {
  test("supply names the stall class and carries a StallSection-valid value", () => {
    const supplied = stallClass.supply(section);
    expect(supplied.classId).toBe("stall");
    expect(supplied.value).toEqual(section);
    expect(StallSectionSchema.safeParse(supplied.value).success).toBe(true);
  });
});
