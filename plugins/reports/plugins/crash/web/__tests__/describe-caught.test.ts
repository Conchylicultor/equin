import { describe, expect, it } from "vitest";
import {
  describeErrorEvent,
  describeRejection,
} from "../internal/describe-caught";

function rejection(reason: unknown): PromiseRejectionEvent {
  // jsdom has no PromiseRejectionEvent constructor: the describer reads `reason` only.
  return { type: "unhandledrejection", reason } as PromiseRejectionEvent;
}

describe("describeErrorEvent", () => {
  it("keeps an Error's own message", () => {
    expect(
      describeErrorEvent(
        new ErrorEvent("error", { error: new TypeError("x is undefined") }),
      ),
    ).toBe("x is undefined");
  });

  it("names an Error thrown with no message by its type", () => {
    expect(
      describeErrorEvent(new ErrorEvent("error", { error: new RangeError() })),
    ).toBe("RangeError with no message");
  });

  it("falls back to the event's own message", () => {
    expect(
      describeErrorEvent(new ErrorEvent("error", { message: "Script error." })),
    ).toBe("Script error.");
  });

  it("names the event type, target and location when nothing carries a message", () => {
    const img = document.createElement("img");
    img.id = "hero";
    img.setAttribute("src", "/a.png");
    const e = new ErrorEvent("error", {
      filename: "https://equin.ai/assets/x.js",
      lineno: 3,
      colno: 9,
      error: "",
    });
    img.dispatchEvent(e);
    expect(describeErrorEvent(e)).toBe(
      "error event on <img#hero> /a.png with no message at https://equin.ai/assets/x.js:3:9, thrown value an empty string",
    );
  });

  it("is never blank", () => {
    expect(describeErrorEvent(new ErrorEvent("error")).trim()).not.toBe("");
  });
});

describe("describeRejection", () => {
  it("keeps an Error's message and a non-empty string reason", () => {
    expect(describeRejection(rejection(new Error("boom")))).toBe("boom");
    expect(describeRejection(rejection("nope"))).toBe("nope");
  });

  it("names the shape of a reason that carries no message", () => {
    expect(describeRejection(rejection(undefined))).toBe(
      "Unhandled rejection with undefined",
    );
    expect(describeRejection(rejection(""))).toBe(
      "Unhandled rejection with an empty string",
    );
    expect(describeRejection(rejection({ code: 1, status: "x" }))).toBe(
      "Unhandled rejection with a Object {code, status}",
    );
    expect(describeRejection(rejection(new Error("")))).toBe(
      "Error with no message",
    );
  });
});
