import { describe, expect, test } from "bun:test";
import { isBotUserAgent } from "./bot-user-agent";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  headless:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36",
};

describe("isBotUserAgent", () => {
  test("crawlers, HTTP libraries and an empty agent are bots", () => {
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      ),
    ).toBe(true);
    expect(isBotUserAgent("curl/8.5.0")).toBe(true);
    expect(isBotUserAgent("python-requests/2.32")).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
  });
  test("real browsers, and headless Chrome, are not", () => {
    expect(isBotUserAgent(UA.chromeMac)).toBe(false);
    expect(isBotUserAgent(UA.safariIphone)).toBe(false);
    expect(isBotUserAgent(UA.headless)).toBe(false);
    // A phone brand ending in "bot" is not a crawler.
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Linux; Android 12; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });
});
