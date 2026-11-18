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

  test("fits the message and the payload to the intake's bounds, saying so", () => {
    const entry = toSiteReport(
      {
        kind: "crash",
        source: "browser-error",
        message: "m".repeat(5_000),
        data: { stack: "s".repeat(5_000), nested: { v: "n".repeat(5_000) } },
      },
      "https://equin.ai/",
    );
    expect(entry.message.length).toBeLessThanOrEqual(1_000);
    expect(entry.message).toContain("chars trimmed");
    expect(JSON.stringify(entry.data).length).toBeLessThanOrEqual(4_096);
    expect(JSON.stringify(entry.data)).toContain("chars trimmed");
  });

  test("a payload too large even clamped is still sent, its largest fields dropped and named", () => {
    const data = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, "v".repeat(100)]),
    );
    const entry = toSiteReport(
      { kind: "crash", source: "browser-error", message: "m", data },
      "https://equin.ai/",
    );
    expect(JSON.stringify(entry.data).length).toBeLessThanOrEqual(4_096);
    expect(entry.message).toStartWith(
      "m [report trimmed to fit its size limit:",
    );
    expect(entry.message.length).toBeLessThanOrEqual(1_000);
  });
});
