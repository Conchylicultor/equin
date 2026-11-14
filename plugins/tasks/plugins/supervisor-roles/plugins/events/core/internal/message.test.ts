import { describe, expect, test } from "bun:test";
import { nextMessageAt, renderEventLine, renderEventMessage } from "./message";

const MIN = 60_000;
const now = new Date("2026-11-14T13:45:00Z");

describe("nextMessageAt", () => {
  test("the first message goes at once", () => {
    expect(nextMessageAt(null, 10 * MIN, now)).toEqual(now);
  });

  test("inside the quiet period, it waits for the period's end", () => {
    const last = new Date("2026-11-14T13:40:00Z");
    expect(nextMessageAt(last, 10 * MIN, now)).toEqual(
      new Date("2026-11-14T13:50:00Z"),
    );
  });

  test("once the quiet period is over, it goes at once again", () => {
    const last = new Date("2026-11-14T13:30:00Z");
    expect(nextMessageAt(last, 10 * MIN, now)).toEqual(now);
  });
});

describe("renderEventMessage", () => {
  const lines = [
    {
      streamId: "errors",
      kind: "endpoint-errors",
      title: "deadline exceeded",
      ref: "report-1",
      count: 16,
    },
    {
      streamId: "errors",
      kind: "crash",
      title: "Worker exited 134",
      ref: null,
      count: 2,
    },
  ];

  test("one summary line per event, never the whole report", () => {
    expect(renderEventLine(lines[0]!)).toBe(
      "×16 endpoint-errors · deadline exceeded (report-1)",
    );
    expect(renderEventLine(lines[1]!)).toBe("×2 crash · Worker exited 134");
  });

  test("a header counting the events, then the lines", () => {
    const text = renderEventMessage(
      lines,
      () => "Error reports",
      new Date("2026-11-14T13:40:00Z"),
    );
    expect(text.split("\n")).toEqual([
      "Error reports — 18 events · 2 distinct since 13:40 UTC",
      "- ×16 endpoint-errors · deadline exceeded (report-1)",
      "- ×2 crash · Worker exited 134",
    ]);
  });
});
