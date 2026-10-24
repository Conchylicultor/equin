/**
 * Pure-logic tests for the serve modes: the rate-limit record is total over the
 * mode set, "immediately" and "never" stay distinguishable, and an unknown mode
 * is a loud failure rather than a silent default. Run with:
 *   ./equin test plugins/plugin-meta/plugins/composition
 */
import { test, expect } from "bun:test";
import {
  SERVE_MODES,
  SERVE_MODE_OPTIONS,
  autoRebuildIntervalMs,
  serveModeLabel,
  isServed,
} from "./serve-mode";

test("every mode has a rate limit and a label", () => {
  // Totality is a tsc property, not a runtime one — but reading every mode here
  // is what proves the records were not widened to a partial index type.
  for (const mode of SERVE_MODES) {
    expect(() => autoRebuildIntervalMs(mode)).not.toThrow();
    expect(serveModeLabel(mode).length).toBeGreaterThan(0);
  }
  expect(SERVE_MODE_OPTIONS.map((o) => o.value)).toEqual([...SERVE_MODES]);
});

test("`push` is 0, not null — immediately is not never", () => {
  // The whole point of the record: an automatic mode with no delay must stay
  // distinguishable from a mode that is never rebuilt. Collapsing 0 into null
  // (or the other way) silently turns "on every push" into "manual".
  expect(autoRebuildIntervalMs("push")).toBe(0);
  expect(autoRebuildIntervalMs("off")).toBe(null);
  expect(autoRebuildIntervalMs("manual")).toBe(null);
});

test("the cadences are their own periods", () => {
  expect(autoRebuildIntervalMs("hourly")).toBe(3_600_000);
  expect(autoRebuildIntervalMs("daily")).toBe(86_400_000);
  expect(autoRebuildIntervalMs("weekly")).toBe(604_800_000);
});

test("an unknown mode throws rather than defaulting", () => {
  expect(() => autoRebuildIntervalMs("hourlyish")).toThrow(/Unknown serve/);
  expect(() => serveModeLabel("")).toThrow(/Unknown serve mode/);
});

test("everything but `off` is a serve intent", () => {
  expect(isServed("off")).toBe(false);
  for (const mode of SERVE_MODES.filter((m) => m !== "off")) {
    expect(isServed(mode)).toBe(true);
  }
});
