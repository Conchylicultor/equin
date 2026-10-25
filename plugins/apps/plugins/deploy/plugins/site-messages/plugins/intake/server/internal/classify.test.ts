import { describe, expect, test } from "bun:test";
import { classifySiteMessage } from "./classify";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

describe("classifySiteMessage", () => {
  test("a person: empty honeypot, a human pace, a browser", () => {
    expect(
      classifySiteMessage({
        honeypot: "",
        elapsedMs: 12_000,
        userAgent: CHROME,
      }),
    ).toEqual({ verdict: "accepted" });
  });

  test("a filled honeypot is spam, even at a human pace", () => {
    expect(
      classifySiteMessage({
        honeypot: "https://spam.example",
        elapsedMs: 12_000,
        userAgent: CHROME,
      }),
    ).toEqual({ verdict: "spam", reason: "honeypot" });
  });

  test("whitespace alone does not trip the honeypot", () => {
    expect(
      classifySiteMessage({
        honeypot: "  ",
        elapsedMs: 12_000,
        userAgent: CHROME,
      }).verdict,
    ).toBe("accepted");
  });

  test("sent under three seconds is spam; at three seconds it is not", () => {
    expect(
      classifySiteMessage({
        honeypot: "",
        elapsedMs: 2_999,
        userAgent: CHROME,
      }),
    ).toEqual({ verdict: "spam", reason: "too-fast" });
    expect(
      classifySiteMessage({ honeypot: "", elapsedMs: 3_000, userAgent: CHROME })
        .verdict,
    ).toBe("accepted");
  });

  test("a crawler or an HTTP library is spam", () => {
    for (const userAgent of ["curl/8.5.0", "python-requests/2.32", ""]) {
      expect(
        classifySiteMessage({ honeypot: "", elapsedMs: 12_000, userAgent }),
      ).toEqual({ verdict: "spam", reason: "bot-user-agent" });
    }
  });
});
