import { describe, expect, test } from "bun:test";
import { reportMessageOrDerived } from "./blank-message";

describe("reportMessageOrDerived", () => {
  test("keeps a real message", () => {
    expect(
      reportMessageOrDerived({
        kind: "crash",
        source: "browser-error",
        message: "boom",
        data: {},
      }),
    ).toBe("boom");
  });

  test("derives a blank message from the error type and the top frame", () => {
    expect(
      reportMessageOrDerived({
        kind: "crash",
        source: "server-caught",
        message: "  ",
        data: {
          errorType: "TypeError",
          stack:
            "TypeError\n    at run (/srv/a.ts:3:9)\n    at b (/srv/b.ts:1:1)",
        },
      }),
    ).toBe(
      "TypeError with no message at run (/srv/a.ts:3:9) (its server-caught filer left the message blank — a collector bug)",
    );
  });

  test("names the kind when there is no error type or stack", () => {
    expect(
      reportMessageOrDerived({
        kind: "render-loop",
        source: "client-render-loop",
        message: "",
        data: {},
      }),
    ).toBe(
      "render-loop report with no message (its client-render-loop filer left the message blank — a collector bug)",
    );
  });
});
