import { describe, expect, test } from "bun:test";
import { parseUserAgent } from "./user-agent";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.99 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  headless:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36",
};

describe("parseUserAgent", () => {
  test.each([
    ["chromeMac", "Desktop", "Chrome", "macOS"],
    ["safariMac", "Desktop", "Safari", "macOS"],
    ["firefoxLinux", "Desktop", "Firefox", "Linux"],
    ["edgeWindows", "Desktop", "Edge", "Windows"],
    ["operaWindows", "Desktop", "Opera", "Windows"],
    ["safariIphone", "Mobile", "Safari", "iOS"],
    ["chromeIphone", "Mobile", "Chrome", "iOS"],
    ["ipad", "Tablet", "Safari", "iOS"],
    ["androidPhone", "Mobile", "Chrome", "Android"],
    ["androidTablet", "Tablet", "Chrome", "Android"],
    ["samsung", "Mobile", "Samsung Internet", "Android"],
    ["chromebook", "Desktop", "Chrome", "ChromeOS"],
  ] as const)("%s", (key, device, browser, os) => {
    expect(parseUserAgent(UA[key])).toEqual({ device, browser, os });
  });

  test("an unknown string falls into the Other families", () => {
    expect(parseUserAgent("SomethingElse/1.0")).toEqual({
      device: "Desktop",
      browser: "Other",
      os: "Other",
    });
  });
});
