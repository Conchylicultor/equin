import { describe, expect, test } from "bun:test";
import { describeTimelineInput, eventsNote } from "./describe";

describe("get_timeline words", () => {
  test("defaults", () => {
    expect(describeTimelineInput({})).toBe("last 30 min");
  });

  test("a historical window with filters (real call)", () => {
    expect(
      describeTimelineInput({
        endIso: "2026-10-31T14:40:00Z",
        lookbackMinutes: 14,
        minSeverity: "warning",
        maxEvents: 80,
      }),
    ).toBe("14 min before 2026-10-31T14:40:00Z · warnings and errors");
  });

  test("hours, errors, sources", () => {
    expect(
      describeTimelineInput({
        lookbackMinutes: 120,
        minSeverity: "error",
        sources: ["slow-op", "trace"],
      }),
    ).toBe("last 2 h · errors only · slow-op, trace");
  });

  test("eventsNote", () => {
    expect(eventsNote(1, 1)).toBe("· 1 event");
    expect(eventsNote(14, 14)).toBe("· 14 events");
    expect(eventsNote(80, 1039)).toBe("· 80 of 1,039 events");
  });
});
