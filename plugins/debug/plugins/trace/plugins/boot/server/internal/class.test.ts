import { describe, expect, test } from "bun:test";
import { BootSectionSchema, type BootSection } from "../../core";
import { bootClass } from "./class";

const section: BootSection = {
  wallStartMs: 1_752_700_000_000,
  totalDurationMs: 12_500,
  timeToReadyMs: 10_400,
  spans: [
    {
      id: "runMigrations",
      phase: "runMigrations",
      label: "Run migrations",
      startMs: 120,
      durationMs: 800,
      physFootprintStartMb: 210.5,
      physFootprintEndMb: 260.1,
    },
    {
      id: "warmup:plugin-tree",
      phase: "warmup",
      plugin: "plugin-meta/plugin-tree",
      label: "warmup:plugin-tree",
      startMs: 9_000,
      durationMs: 3_500,
    },
  ],
  memoryCheckpoints: [
    { label: "after-migrations", atMs: 950, physFootprintMb: 260.1, heapUsedMb: 90.2 },
  ],
  gateway: {
    spawnRequestedAt: 1_752_699_999_500,
    spawnedAt: 1_752_700_000_000,
    readyObservedAt: 1_752_700_008_000,
    escalated: false,
    respondedHTTP: true,
    demoted: false,
  },
};

describe("bootClass", () => {
  test("supply names the boot class and carries a BootSection-valid value", () => {
    const supplied = bootClass.supply(section);
    expect(supplied.classId).toBe("boot");
    expect(supplied.value).toEqual(section);
    // The engine validates each section against the class schema before persist.
    expect(BootSectionSchema.safeParse(supplied.value).success).toBe(true);
  });

  test("a gateway-less section (older gateway never POSTed) is still schema-valid", () => {
    const { gateway: _gateway, ...withoutGateway } = section;
    expect(BootSectionSchema.safeParse(withoutGateway).success).toBe(true);
    // Skew tolerance the other way: a partial gateway report stays valid too.
    expect(
      BootSectionSchema.safeParse({ ...withoutGateway, gateway: { escalated: true } }).success,
    ).toBe(true);
  });
});
