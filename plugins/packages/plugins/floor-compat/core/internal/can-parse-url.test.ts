import { describe, expect, test } from "bun:test";
import { canParseUrl } from "./compat";

describe("canParseUrl", () => {
  test("answers as URL.canParse does", () => {
    const cases: [string, string | undefined][] = [
      ["https://equin.ai/a?b#c", undefined],
      ["/relative", undefined],
      ["/relative", "https://equin.ai"],
      ["not a url", undefined],
      ["", "https://equin.ai/x"],
      ["http://[::1", undefined],
      ["mailto:a@b.c", undefined],
    ];
    for (const [raw, base] of cases)
      expect(canParseUrl(raw, base)).toBe(URL.canParse(raw, base));
  });
});
