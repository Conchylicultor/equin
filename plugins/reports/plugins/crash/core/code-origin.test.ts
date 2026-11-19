import { describe, expect, test } from "bun:test";
import { stackCodeOrigin } from "./code-origin";

const page = {
  documentUrl: "https://equin.ai/demo?x=1#top",
  inlineScripts: [
    `document.documentElement.setAttribute("data-color-scheme", "dark");`,
    `(function () { function showBootFailure(e) { throw e; } })();`,
  ],
};

describe("stackCodeOrigin", () => {
  test("Dark Reader's stylesheet proxy in Firefox (report-1795102621-60704g): foreign", () => {
    const stack = [
      "overrideProperty/<@https://equin.ai/demo:51:24",
      "cleanUp/<@https://equin.ai/demo:10:41",
      "cleanUp@https://equin.ai/demo:10:22",
    ].join("\n");
    expect(stackCodeOrigin(stack, page)).toBe("foreign");
  });

  test("an extension scheme or another origin: foreign", () => {
    expect(
      stackCodeOrigin(
        "f@moz-extension://abc/content.js:1:2\ng@https://cdn.example/x.js:3:4",
        page,
      ),
    ).toBe("foreign");
    expect(
      stackCodeOrigin(
        "TypeError: x\n    at f (chrome-extension://abc/c.js:1:2)\n    at Array.forEach (<anonymous>)",
        page,
      ),
    ).toBe("foreign");
  });

  test("one frame in a script file of the page's origin: page", () => {
    const stack = [
      "TypeError: x",
      "    at f (chrome-extension://abc/c.js:1:2)",
      "    at render (https://equin.ai/artifacts/chunk.0123456789abcdef/index.js:4:5)",
    ].join("\n");
    expect(stackCodeOrigin(stack, page)).toBe("page");
  });

  test("a document frame named by one of the page's inline scripts: page", () => {
    expect(
      stackCodeOrigin("showBootFailure@https://equin.ai/demo:130:5", page),
    ).toBe("page");
  });

  test("an anonymous document frame or an injected-element frame: unknown", () => {
    expect(stackCodeOrigin("@https://equin.ai/demo:10:22", page)).toBe(
      "unknown",
    );
    expect(
      stackCodeOrigin(
        "f@https://equin.ai/demo line 11 > injectedScript:1:28",
        page,
      ),
    ).toBe("unknown");
    // A foreign frame does not outweigh an undecidable one.
    expect(
      stackCodeOrigin(
        "f@moz-extension://a/b.js:1:1\n@https://equin.ai/demo:3:3",
        page,
      ),
    ).toBe("unknown");
  });

  test("no stack, or no frames: unknown", () => {
    expect(stackCodeOrigin(null, page)).toBe("unknown");
    expect(stackCodeOrigin("TypeError: boom", page)).toBe("unknown");
    expect(stackCodeOrigin("    at Array.forEach (<anonymous>)", page)).toBe(
      "unknown",
    );
  });
});
