import { describe, expect, test } from "bun:test";
import { toSiteReport } from "./to-entry";

describe("toSiteReport", () => {
  test("anonymous: no client id or user agent, the pathname only", () => {
    const entry = toSiteReport(
      {
        kind: "crash",
        source: "browser-error",
        message: "boom",
        data: { errorType: "Error", stack: "x" },
        url: "https://equin.ai/demo/tasks?q=secret#frag",
        userAgent: "Mozilla/5.0",
        clientId: "tab-1",
        buildId: "b",
        commit: "c",
      },
      "https://equin.ai/",
    );
    expect(entry).toEqual({
      kind: "crash",
      source: "browser-error",
      message: "boom",
      data: { errorType: "Error", stack: "x" },
      path: "/demo/tasks",
      buildId: "b",
      commit: "c",
    });
  });

  test("clamps the message and every payload string", () => {
    const entry = toSiteReport(
      {
        kind: "crash",
        source: "browser-error",
        message: "m".repeat(5_000),
        data: { stack: "s".repeat(5_000), nested: { v: "n".repeat(5_000) } },
      },
      "https://equin.ai/",
    )!;
    expect(entry.message.length).toBe(1_000);
    expect(JSON.stringify(entry.data).length).toBeLessThanOrEqual(4_096);
  });

  test("a payload too large even clamped is not sent", () => {
    const data = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, "v".repeat(100)]),
    );
    expect(
      toSiteReport(
        { kind: "crash", source: "browser-error", message: "m", data },
        "https://equin.ai/",
      ),
    ).toBeNull();
  });
});
