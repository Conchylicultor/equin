import { describe, expect, test } from "bun:test";
import { siteReportSender } from "./sender";

const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

describe("siteReportSender", () => {
  test("a person's browser is a visitor, keyed by its address", () => {
    expect(
      siteReportSender({
        ip: "203.0.113.4",
        userAgent: SAFARI_IOS,
        automated: false,
      }),
    ).toEqual({ kind: "visitor", ip: "203.0.113.4" });
  });

  test("a crawler or an HTTP library is a bot", () => {
    for (const userAgent of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "curl/8.7.1",
      "python-requests/2.32.3",
      "",
    ]) {
      expect(
        siteReportSender({ ip: "203.0.113.4", userAgent, automated: false }),
      ).toEqual({ kind: "bot" });
    }
  });

  test("a page under automation is automated, whatever its user agent", () => {
    expect(
      siteReportSender({
        ip: "203.0.113.4",
        userAgent: SAFARI_IOS,
        automated: true,
      }),
    ).toEqual({ kind: "automated" });
  });
});
