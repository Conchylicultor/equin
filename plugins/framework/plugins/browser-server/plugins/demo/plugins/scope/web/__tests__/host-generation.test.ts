/**
 * The host generation a demo tab connects to: 0 (the scenario's own name)
 * until a Reset; each Reset moves past the generation it ends, never back —
 * the tab that sent it and every tab told the host ended agree on the next
 * name, whichever writes first, so no tab asks for the worker that closed.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  advanceHostGeneration,
  hostGeneration,
  hostWorkerName,
  trackHostGenerations,
} from "../internal/host-generation";

afterEach(() => localStorage.clear());

describe("host generation", () => {
  it("starts at 0, named as the scenario", () => {
    expect(hostGeneration("s")).toBe(0);
    expect(hostWorkerName("s", 0)).toBe("s");
  });

  it("a Reset moves every tab to the next generation's worker", () => {
    // The resetting tab, then a tab told `ended: "reset"` from the same one.
    expect(advanceHostGeneration("s", 0)).toBe(1);
    expect(advanceHostGeneration("s", 0)).toBe(1);
    expect(hostGeneration("s")).toBe(1);
    expect(hostWorkerName("s", 1)).not.toBe(hostWorkerName("s", 0));
    expect(advanceHostGeneration("s", 1)).toBe(2);
  });

  it("never goes back, and keeps scenarios apart", () => {
    advanceHostGeneration("s", 4);
    // A tab still on an older generation moves past the stored one, not to it.
    expect(advanceHostGeneration("s", 1)).toBe(5);
    expect(hostGeneration("other")).toBe(0);
  });
});

describe("trackHostGenerations", () => {
  it("reads the stored generation when it connects, never below its own", () => {
    const tab = trackHostGenerations("s");
    expect(tab.current()).toBe(0);
    // Another tab reset meanwhile: read at connect, not when the effect ran.
    advanceHostGeneration("s", 0);
    expect(tab.current()).toBe(1);
    tab.advance(1);
    // The store lost (cleared, unreadable): this tab stays past what it left.
    localStorage.clear();
    expect(tab.current()).toBe(2);
  });
});
