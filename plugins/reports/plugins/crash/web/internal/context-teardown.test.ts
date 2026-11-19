import { describe, expect, test } from "bun:test";
import { isContextTeardown } from "./context-teardown";

const WEBKIT_WORDS =
  "Promise was rejected because the browsing context is going away";

describe("isContextTeardown", () => {
  test("WebKit's teardown rejection of a lock or permission promise", () => {
    expect(isContextTeardown(new DOMException(WEBKIT_WORDS, "AbortError"))).toBe(
      true,
    );
  });

  test("any other AbortError is still a crash", () => {
    expect(
      isContextTeardown(
        new DOMException("The operation was aborted.", "AbortError"),
      ),
    ).toBe(false);
  });

  test("the same words under another name or type are not it", () => {
    expect(
      isContextTeardown(new DOMException(WEBKIT_WORDS, "InvalidStateError")),
    ).toBe(false);
    expect(isContextTeardown(new Error(WEBKIT_WORDS))).toBe(false);
    expect(isContextTeardown(WEBKIT_WORDS)).toBe(false);
  });
});
