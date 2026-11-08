import { describe, expect, test } from "bun:test";
import { echoEventOf } from "./echo-event";

const sentAt = new Date("2026-11-08T16:28:49.274Z");

describe("echoEventOf", () => {
  test("an event turn's echo is the event card its line becomes, not a user message", () => {
    expect(
      echoEventOf({
        id: "turn-1",
        kind: "event",
        text: "2 events in the tasks you watch:",
        sentAt,
      }),
    ).toEqual({
      kind: "event-turn",
      at: sentAt.toISOString(),
      text: "2 events in the tasks you watch:",
      uuid: "turn-1",
    });
  });

  test("a typed turn's echo is the user's message", () => {
    expect(
      echoEventOf({ id: "turn-2", kind: "turn", text: "hi", sentAt }).kind,
    ).toBe("user-text");
  });
});
