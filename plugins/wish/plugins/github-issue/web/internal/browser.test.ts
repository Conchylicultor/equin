import { describe, expect, test } from "bun:test";
import { describeBrowser } from "./browser";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";

describe("describeBrowser", () => {
  test("names the browser, its major version and the system", () => {
    expect(describeBrowser(CHROME_MAC)).toBe("Chrome 142 on macOS");
    expect(describeBrowser(SAFARI_MAC)).toBe("Safari 18.2 on macOS");
    expect(describeBrowser(FIREFOX_LINUX)).toBe("Firefox 133 on Linux");
  });

  test("tells a Chromium derivative from Chrome", () => {
    expect(describeBrowser(EDGE_WIN)).toBe("Edge 142 on Windows");
  });

  test("reads an iPhone as iOS, not macOS", () => {
    expect(describeBrowser(CHROME_IOS)).toBe("Chrome 131 on iOS");
  });

  test("reads headless Chrome (an automated browser) as Chrome", () => {
    expect(
      describeBrowser(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 142 on macOS");
  });

  test("says so when it recognises nothing", () => {
    expect(describeBrowser("curl/8.0")).toBe("Unknown browser");
  });
});
