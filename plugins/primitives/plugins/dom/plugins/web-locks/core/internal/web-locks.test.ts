import { describe, expect, test } from "bun:test";
import { locksRefused, webLocks } from "./web-locks";

describe("webLocks", () => {
  test("no navigator at all is unsupported", () => {
    expect(webLocks(undefined)).toEqual({ kind: "unsupported" });
  });

  test("a navigator without locks (Safari Lockdown, a webview's worker) is unsupported", () => {
    expect(webLocks({})).toEqual({ kind: "unsupported" });
  });

  test("a locks object without request is unsupported", () => {
    expect(webLocks({ locks: {} as LockManager }).kind).toBe("unsupported");
  });

  test("a lock manager is handed back", () => {
    const locks = {
      request: () => Promise.resolve(),
      query: () => Promise.resolve({}),
    } as unknown as LockManager;
    const answer = webLocks({ locks });
    expect(answer.kind).toBe("supported");
    if (answer.kind === "supported") expect(answer.locks).toBe(locks);
  });

  test("Bun's own navigator has none", () => {
    expect(webLocks().kind).toBe("unsupported");
  });
});

describe("locksRefused", () => {
  test("a SecurityError is a refusal", () => {
    expect(locksRefused(new DOMException("no", "SecurityError"))).toBe(true);
  });
  test("anything else is not", () => {
    expect(locksRefused(new DOMException("no", "AbortError"))).toBe(false);
    expect(locksRefused(new Error("x"))).toBe(false);
  });
});
