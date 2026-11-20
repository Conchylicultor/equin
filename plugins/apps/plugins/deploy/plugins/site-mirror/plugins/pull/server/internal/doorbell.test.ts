import { describe, expect, test } from "bun:test";
import { DOORBELL_SPACING_MS, doorbellRunAt } from "./doorbell";

describe("doorbellRunAt", () => {
  const now = 1_000_000;
  test("a replica never attempted is pulled now", () => {
    expect(doorbellRunAt(now, null, DOORBELL_SPACING_MS)).toBe(now);
  });
  test("an attempt longer ago than the spacing: now", () => {
    expect(doorbellRunAt(now, now - 6_000, DOORBELL_SPACING_MS)).toBe(now);
  });
  test("an attempt closer than the spacing: at last attempt + spacing", () => {
    expect(doorbellRunAt(now, now - 2_000, DOORBELL_SPACING_MS)).toBe(
      now + 3_000,
    );
  });
  test("exactly the spacing ago: now", () => {
    expect(
      doorbellRunAt(now, now - DOORBELL_SPACING_MS, DOORBELL_SPACING_MS),
    ).toBe(now);
  });
  test("a sink's pace spaces by its own interval", () => {
    const minIntervalMs = 15 * 60_000;
    expect(doorbellRunAt(now, now - 60_000, minIntervalMs)).toBe(
      now - 60_000 + minIntervalMs,
    );
  });
  test("a storm of rings at one instant asks for one deadline", () => {
    const last = now - 1_000;
    const asked = [0, 10, 20].map((dt) =>
      doorbellRunAt(now + dt, last, DOORBELL_SPACING_MS),
    );
    expect(new Set(asked).size).toBe(1);
  });
});
