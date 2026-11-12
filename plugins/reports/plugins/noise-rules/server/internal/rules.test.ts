import { describe, expect, test } from "bun:test";
import type { ReportNoiseInput } from "@plugins/reports/server";
import { resizeObserverRule } from "./rules";

const input = (over: Partial<ReportNoiseInput>): ReportNoiseInput => ({
  source: "browser-error",
  errorType: null,
  message: "",
  stack: null,
  versionSkew: false,
  ...over,
});

describe("resize-observer", () => {
  test("the browser's own ResizeObserver loop warning is noise", () => {
    expect(
      resizeObserverRule.matches(
        input({
          message:
            "ResizeObserver loop completed with undelivered notifications.",
        }),
      ),
    ).toBe(true);
  });

  test("another report that merely names a ResizeObserver callback is not (a 7.2 s main-thread freeze was muted that way)", () => {
    expect(
      resizeObserverRule.matches(
        input({
          source: "client-main-thread-stall",
          message:
            "Main thread frozen 7.2s (recovered) — demo (root) — (anonymous) (ResizeObserverCallback)",
        }),
      ),
    ).toBe(false);
  });
});
