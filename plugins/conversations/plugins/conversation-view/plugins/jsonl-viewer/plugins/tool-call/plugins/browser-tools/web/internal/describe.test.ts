import { describe, expect, test } from "bun:test";
import { describeBrowserCall } from "./describe";

const T = (n: string) => `mcp__equin__browser_${n}`;

describe("describeBrowserCall", () => {
  test("navigate shows the url", () => {
    expect(describeBrowserCall(T("navigate"), { url: "/agents" }).summary).toBe(
      "/agents",
    );
  });
  test("javascript shows the first non-empty line and the code", () => {
    const v = describeBrowserCall(T("javascript"), {
      code: "\n return 1;\nfoo()",
    });
    expect(v.summary).toBe("return 1;");
    expect(v.body?.lang).toBe("javascript");
  });
  test("act names action and target", () => {
    expect(
      describeBrowserCall(T("act"), { action: "fill", ref: "e3", text: "hi" })
        .summary,
    ).toBe('fill e3 "hi"');
  });
  test("viewport", () => {
    expect(
      describeBrowserCall(T("viewport"), { width: 390, height: 800 }).summary,
    ).toBe("390×800");
  });
  test("tolerates an empty streaming input", () => {
    expect(describeBrowserCall(T("find"), undefined).summary).toBe("find");
    expect(describeBrowserCall(T("batch"), { actions: [{}] }).summary).toBe("");
  });
});
