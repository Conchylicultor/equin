import { describe, expect, test } from "bun:test";
import { eventPropValue, parseEventPropValue } from "./event-prop";

describe("event_prop values", () => {
  test("round-trip, a value holding . and = included", () => {
    const stored = eventPropValue("card_open", "card", "a.b=c");
    expect(stored).toBe("card_open.card=a.b=c");
    expect(parseEventPropValue(stored)).toEqual({
      event: "card_open",
      key: "card",
      value: "a.b=c",
    });
  });

  test("an empty value", () => {
    expect(parseEventPropValue("e.k=")).toEqual({
      event: "e",
      key: "k",
      value: "",
    });
  });

  test("refuses a value it did not build", () => {
    expect(() => parseEventPropValue("no_separator")).toThrow();
    expect(() => parseEventPropValue("e.k")).toThrow();
    expect(() => parseEventPropValue("E.k=v")).toThrow();
  });
});
