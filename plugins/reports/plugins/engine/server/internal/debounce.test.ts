/**
 * Suite for the per-key report debounce gate: the thing that stops a
 * persistent condition observed on a 1 Hz loop from upserting a report row
 * every second forever.
 *
 * Pure — the gate has no dependencies, so this needs no database and no
 * running cluster. `now` is passed explicitly rather than mocked so the window
 * boundaries are stated in the test rather than in a timer.
 *
 * Run: `./singularity test plugins/reports`
 */

import { describe, test, expect } from "bun:test";
import { createReportDebounce, DEFAULT_REPORT_DEBOUNCE_MS } from "./debounce";

const WINDOW = 5 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe("createReportDebounce", () => {
  test("admits the first occurrence of a key", () => {
    const gate = createReportDebounce();
    expect(gate.admit("k", WINDOW, T0)).toBe(true);
  });

  test("drops repeats inside the window, including at its last instant", () => {
    const gate = createReportDebounce();
    gate.admit("k", WINDOW, T0);
    expect(gate.admit("k", WINDOW, T0)).toBe(false);
    expect(gate.admit("k", WINDOW, T0 + 1_000)).toBe(false);
    expect(gate.admit("k", WINDOW, T0 + WINDOW - 1)).toBe(false);
  });

  test("admits again once the window has elapsed", () => {
    const gate = createReportDebounce();
    gate.admit("k", WINDOW, T0);
    expect(gate.admit("k", WINDOW, T0 + WINDOW)).toBe(true);
  });

  test("the window restarts from the admitted occurrence, not the dropped ones", () => {
    const gate = createReportDebounce();
    gate.admit("k", WINDOW, T0);
    gate.admit("k", WINDOW, T0 + WINDOW - 1); // dropped — must not extend the window
    expect(gate.admit("k", WINDOW, T0 + WINDOW)).toBe(true);
  });

  test("distinct keys are distinct signals", () => {
    const gate = createReportDebounce();
    expect(gate.admit("a", WINDOW, T0)).toBe(true);
    expect(gate.admit("b", WINDOW, T0)).toBe(true);
    expect(gate.admit("a", WINDOW, T0)).toBe(false);
  });

  test("sweeps keys older than the window, so an open-ended key space stays bounded", () => {
    const gate = createReportDebounce();
    for (let i = 0; i < 100; i++) gate.admit(`pane-${i}`, WINDOW, T0);
    expect(gate.size()).toBe(100);

    // The sweep runs on admission: one key past the window reclaims the 100
    // stale ones and leaves only itself.
    expect(gate.admit("later", WINDOW, T0 + WINDOW)).toBe(true);
    expect(gate.size()).toBe(1);
  });

  test("a key emitted inside the window survives the sweep", () => {
    const gate = createReportDebounce();
    gate.admit("old", WINDOW, T0);
    gate.admit("recent", WINDOW, T0 + WINDOW - 1);
    gate.admit("trigger", WINDOW, T0 + WINDOW);
    expect(gate.size()).toBe(2); // "old" reclaimed; "recent" + "trigger" kept
  });

  test("the default window is 5 minutes", () => {
    expect(DEFAULT_REPORT_DEBOUNCE_MS).toBe(WINDOW);
  });
});
