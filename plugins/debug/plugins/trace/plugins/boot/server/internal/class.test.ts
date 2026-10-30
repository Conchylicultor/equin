import { describe, expect, test } from "bun:test";
import type { TripContext, TraceTrigger } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { BootSectionSchema, type BootSection } from "../../core";
import { captureBootSection } from "./class";

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

function ctxFor(trigger: TraceTrigger): TripContext {
  return { id: "t", atMs: 1_000, wallTime: "2026-07-17T00:00:00.000Z", windowStartMs: 0, trigger };
}

describe("captureBootSection", () => {
  test("passes a boot trigger's detail through, and it is BootSection-valid", () => {
    const out = captureBootSection(
      ctxFor({
        kind: "boot",
        label: "server-ready",
        durationMs: 10_400,
        thresholdMs: 10_000,
        detail: section,
      }),
    );
    expect(out).toEqual(section);
    // The engine validates each section against the class schema before persist —
    // assert the passthrough output actually satisfies it (no empty/faked section).
    expect(BootSectionSchema.safeParse(out).success).toBe(true);
  });

  test("a gateway-less section (older gateway never POSTed) is still schema-valid", () => {
    const { gateway: _gateway, ...withoutGateway } = section;
    expect(BootSectionSchema.safeParse(withoutGateway).success).toBe(true);
    // Skew tolerance the other way: a partial gateway report stays valid too.
    expect(
      BootSectionSchema.safeParse({ ...withoutGateway, gateway: { escalated: true } }).success,
    ).toBe(true);
  });

  test("returns undefined for a non-boot trip (no empty boot section on a slow span)", () => {
    expect(
      captureBootSection(ctxFor({ kind: "loader", label: "x", durationMs: 500, thresholdMs: 100 })),
    ).toBeUndefined();
    expect(
      captureBootSection(ctxFor({ kind: "stall", label: "y", durationMs: 9_000, thresholdMs: 3_000, critical: true })),
    ).toBeUndefined();
  });
});
