import { describe, expect, test } from "bun:test";
import { fitReportBody, REPORT_SIZE_LIMITS, trimText } from "./fit";
import type { ReportBody } from "./report-body";

const bytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length;

// The shape that went missing: a host boot losing one module every plugin
// imports — its message names each plugin with its URL, and the stack repeats
// the message before its frames.
function bootFailure(): ReportBody {
  const lines = Array.from(
    { length: 268 },
    (_, i) =>
      `  plugin-${i}: Failed to fetch dynamically imported module: https://equin.ai/artifacts/plugin-${i}.server.0123456789abcdef/index.js`,
  );
  const message = `in-browser server failed to boot:\n${lines.join("\n")}`;
  const frames = Array.from(
    { length: 10 },
    (_, i) => `    at frame${i} (https://equin.ai/artifacts/host.js:${i}:1)`,
  );
  return {
    kind: "crash",
    source: "browser-error",
    message,
    data: {
      errorType: "PortHostBootError",
      stack: `PortHostBootError: ${message}\n${frames.join("\n")}`,
    },
    url: "https://equin.ai/about/demo",
  };
}

describe("trimText", () => {
  test("a string that fits is unchanged", () => {
    expect(trimText("abc", 3)).toBe("abc");
  });

  test("a cut string fits, keeps its head and tail, and names the cut", () => {
    const text = `${"a".repeat(5_000)}${"z".repeat(5_000)}`;
    const out = trimText(text, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toStartWith("aaa");
    expect(out).toEndWith("zzz");
    expect(out).toMatch(/… \[[\d,]+ chars trimmed\] …/);
  });

  test("a cut never splits a character", () => {
    for (let max = 60; max < 140; max++) {
      const out = trimText("😀".repeat(200), max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
      );
    }
  });

  test("max 0 is the empty string", () => {
    expect(trimText("abc", 0)).toBe("");
  });

  test("a multi-line cut keeps whole lines and the last ones", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = trimText(text, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.split("\n")[0]).toBe("line 0");
    expect(out).toEndWith("line 499");
    expect(out).toContain("\n… [");
  });
});

describe("trimText on a stack", () => {
  const message = Array.from(
    { length: 300 },
    (_, i) => `plugin-${i} lost`,
  ).join("\n");
  const frames = Array.from(
    { length: 60 },
    (_, i) => `    at frame${i} (https://equin.ai/artifacts/host.js:${i}:1)`,
  );
  const stack = `PortHostBootError: ${message}\n${frames.join("\n")}`;

  test("keeps every frame, cutting the message it opens with", () => {
    const out = trimText(stack, 4_000);
    expect(out.length).toBeLessThanOrEqual(4_000);
    expect(out).toStartWith("PortHostBootError: plugin-0 lost");
    expect(out).toContain("chars trimmed");
    for (let i = 0; i < 60; i++) expect(out).toContain(`at frame${i} `);
  });

  test("too many frames to fit: the top ones stay", () => {
    const out = trimText(stack, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    for (let i = 0; i < 3; i++) expect(out).toContain(`at frame${i} `);
    expect(out).not.toContain("at frame59 ");
    expect(out).toMatch(/chars trimmed\]$/);
  });

  test("Safari / Firefox frames count as frames", () => {
    const safari = `${"x".repeat(5_000)}\nf@https://a/b.js:1:2\ng@https://a/c.js:3:4`;
    const out = trimText(safari, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toEndWith("f@https://a/b.js:1:2\ng@https://a/c.js:3:4");
  });
});

describe("fitReportBody", () => {
  test("a report that fits is unchanged", () => {
    const body: ReportBody = {
      kind: "crash",
      source: "browser-error",
      message: "boom",
      data: { errorType: "Error", stack: "Error: boom\n at f (a.js:1:1)" },
    };
    expect(fitReportBody(body, REPORT_SIZE_LIMITS)).toEqual(body);
  });

  test("a boot failure naming every plugin fits a keepalive fetch, keeps its frames and says it was trimmed", () => {
    const body = bootFailure();
    expect(bytes(body)).toBeGreaterThan(64 * 1024);
    const fitted = fitReportBody(body, REPORT_SIZE_LIMITS);
    expect(bytes(fitted)).toBeLessThan(40 * 1024);
    expect(fitted.message.length).toBeLessThanOrEqual(
      REPORT_SIZE_LIMITS.maxMessage,
    );
    expect(fitted.message).toStartWith("in-browser server failed to boot:");
    expect(fitted.message).toContain("chars trimmed");
    const stack = fitted.data.stack as string;
    expect(stack).toStartWith("PortHostBootError: ");
    expect(stack).toContain("chars trimmed");
    // The frames — the crash's identity — survive the cut.
    for (let i = 0; i < 10; i++) expect(stack).toContain(`at frame${i} `);
    expect(fitted.data.errorType).toBe("PortHostBootError");
  });

  test("a payload too large with every string short drops its largest fields, named in the message", () => {
    const data: Record<string, unknown> = { keep: "small" };
    for (let i = 0; i < 400; i++) data[`k${i}`] = "v".repeat(100);
    const fitted = fitReportBody(
      { kind: "x", source: "browser-error", message: "m", data },
      REPORT_SIZE_LIMITS,
    );
    expect(bytes(fitted.data)).toBeLessThanOrEqual(
      REPORT_SIZE_LIMITS.maxDataBytes,
    );
    expect(fitted.data.keep).toBe("small");
    expect(fitted.message).toMatch(
      /^m \[report trimmed to fit its size limit: data\.k\d+ dropped/,
    );
  });

  test("a long array keeps its first items, the cut named in the message", () => {
    const items = Array.from({ length: 2_000 }, (_, i) => ({
      i,
      s: "x".repeat(40),
    }));
    const fitted = fitReportBody(
      { kind: "x", source: "browser-error", message: "m", data: { items } },
      REPORT_SIZE_LIMITS,
    );
    expect(bytes(fitted.data)).toBeLessThanOrEqual(
      REPORT_SIZE_LIMITS.maxDataBytes,
    );
    expect((fitted.data.items as unknown[])[0]).toEqual(items[0]);
    expect(fitted.message).toContain("data.items kept 100 of 2000 items");
  });
});
