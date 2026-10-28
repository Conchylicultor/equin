import { describe, expect, test } from "bun:test";
import { typedTextOf, unwrapEventTurn, wrapEventTurn } from "./event-envelope";

describe("event envelope", () => {
  test("round-trips a body", () => {
    const body = "reported · task-1 · Fix it\n\nall done";
    expect(unwrapEventTurn(wrapEventTurn(body))).toBe(body);
  });

  test("round-trips an empty body", () => {
    expect(unwrapEventTurn(wrapEventTurn(""))).toBe("");
  });

  test("tolerates surrounding whitespace", () => {
    expect(unwrapEventTurn(`\n  ${wrapEventTurn("x")}  \n`)).toBe("x");
  });

  test("a message that only mentions the tag is not an event", () => {
    expect(unwrapEventTurn("see <equin-event>x</equin-event> above")).toBe(
      null,
    );
    expect(unwrapEventTurn("hello")).toBe(null);
  });

  test("only an event turn is typed inside the envelope", () => {
    expect(typedTextOf("event", "x")).toBe(wrapEventTurn("x"));
    expect(typedTextOf("turn", "x")).toBe("x");
    expect(typedTextOf("launch", "x")).toBe("x");
  });
});
