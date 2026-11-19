import { describe, expect, test } from "bun:test";
import {
  TYPE_CHECK_FULL_PROFILE,
  TYPE_CHECK_ONE_UNIT_PROFILE,
  TYPE_CHECK_WORKER_UNITS,
  typeCheckProfileFor,
} from "./worker-weight";

describe("typeCheckProfileFor", () => {
  test("a share holding the worker's weight runs the full profile", () => {
    expect(typeCheckProfileFor(TYPE_CHECK_WORKER_UNITS)).toBe(
      TYPE_CHECK_FULL_PROFILE,
    );
    expect(typeCheckProfileFor(TYPE_CHECK_WORKER_UNITS + 3)).toBe(
      TYPE_CHECK_FULL_PROFILE,
    );
  });
  test("a share the grant clamped below the weight runs the one-unit profile", () => {
    expect(TYPE_CHECK_WORKER_UNITS).toBeGreaterThan(1);
    expect(typeCheckProfileFor(1)).toBe(TYPE_CHECK_ONE_UNIT_PROFILE);
  });
  test("the one-unit profile is the smaller one on both axes", () => {
    expect(TYPE_CHECK_ONE_UNIT_PROFILE.batchFiles).toBeLessThan(
      TYPE_CHECK_FULL_PROFILE.batchFiles,
    );
    expect(TYPE_CHECK_ONE_UNIT_PROFILE.heapRamBytes).toBeLessThan(
      TYPE_CHECK_FULL_PROFILE.heapRamBytes,
    );
  });
  test("a share of no units is a bug, never a profile", () => {
    expect(() => typeCheckProfileFor(0)).toThrow(/positive integer/);
    expect(() => typeCheckProfileFor(1.5)).toThrow(/positive integer/);
  });
});
