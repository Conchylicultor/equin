import { describe, expect, test } from "bun:test";
import {
  ClientBootSectionSchema,
  toClientBootSection,
  type ClientBootSection,
} from "../../core/section";
import { clientBootClass } from "./class";

const section: ClientBootSection = toClientBootSection({
  spans: [
    {
      id: "s1",
      phase: "boot-tasks",
      label: "boot snapshot",
      startMs: 100,
      durationMs: 400,
    },
  ],
  navigation: null,
  paint: { firstPaintMs: 900, firstContentfulPaintMs: 950 },
  firstCommitMs: 800,
  longTasks: [{ startMs: 300, durationMs: 120, name: "self" }],
  assets: [
    {
      name: "http://x.localhost:9000/assets/chunk-a.js",
      initiatorType: "script",
      startMs: 10,
      responseStartMs: 40,
      responseEndMs: 90,
      transferSize: 50_000,
      decodedBodySize: 150_000,
    },
  ],
  capturedAt: 1_752_000_000_000,
});

describe("clientBootClass", () => {
  test("supply names the client-boot class and carries a ClientBootSection-valid value", () => {
    const supplied = clientBootClass.supply(section);
    expect(supplied.classId).toBe("client-boot");
    expect(supplied.value).toEqual(section);
    expect(ClientBootSectionSchema.safeParse(supplied.value).success).toBe(
      true,
    );
  });
});
