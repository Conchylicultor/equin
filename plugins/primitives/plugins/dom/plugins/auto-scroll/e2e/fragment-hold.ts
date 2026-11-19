/**
 * The browser's hold on a fragment target ends when the reader acts
 * (`BrowserHoldRelease`): in WebKit, opening the story on a text-fragment link
 * and then scrolling the pane away must leave the pane where the reader put it.
 * Without the release, WebKit reveals the target again after every layout (the
 * story's figures lay out every frame) and the reader is pulled back: the iOS
 * Safari "bounce".
 *
 *   ./equin run plugins/primitives/plugins/dom/plugins/auto-scroll/e2e/fragment-hold.ts \
 *     [--url https://equin.ai/story]
 *
 * Runs Playwright's WebKit with an iPhone profile (not Chromium, which has no
 * such hold). The reader's scroll is written to the pane's scroller after a
 * touchstart. That is the iOS path: Safari scrolls an inner scroller in the UI
 * process, and the frame never counts that scroll as the user's.
 */
import { devices, webkit } from "playwright";
import {
  pageUrl,
  report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const FRAGMENT =
  "#:~:text=A%20review%20queue%2C%20so%20I%20never%20lose%20track%20of%20the%20tasks%20I%20launched";
const r = report("auto-scroll:fragment-hold");
const url = pageUrl("/about/story") + FRAGMENT;
r.note(`target ${url}`);

const browser = await webkit.launch();
try {
  const page = await (await browser.newContext(devices["iPhone 15"])).newPage();
  await page.goto(url, { waitUntil: "load" });
  // The pane scroller: the one overflowing element that scrolls vertically.
  const offset = () =>
    page.evaluate(() => {
      const sc = [...document.querySelectorAll<HTMLElement>("div")].find(
        (d) =>
          d.scrollHeight > d.clientHeight + 100 &&
          getComputedStyle(d).overflowY === "auto",
      );
      return sc ? Math.round(sc.scrollTop) : null;
    });
  await page.waitForFunction(
    () => {
      const li = [...document.querySelectorAll("li")].find((l) =>
        l.textContent?.includes("A review queue"),
      );
      if (!li) return false;
      const top = li.getBoundingClientRect().top;
      return top > 0 && top < innerHeight;
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1500);
  const landed = await offset();
  r.ok("the fragment link scrolled the pane", (landed ?? 0) > 0, `${landed}`);

  const wanted = Math.max(0, (landed ?? 0) - 1500);
  await page.evaluate(async (to) => {
    const sc = [...document.querySelectorAll<HTMLElement>("div")].find(
      (d) =>
        d.scrollHeight > d.clientHeight + 100 &&
        getComputedStyle(d).overflowY === "auto",
    )!;
    sc.dispatchEvent(new TouchEvent("touchstart", { bubbles: true }));
    const from = sc.scrollTop;
    for (let i = 1; i <= 10; i++) {
      sc.scrollTop = from + ((to - from) * i) / 10;
      await new Promise((done) => setTimeout(done, 30));
    }
  }, wanted);
  // Long enough for many layouts of the animated figures.
  await page.waitForTimeout(3000);
  const after = await offset();
  r.eq("the pane stays where the reader scrolled it", after, wanted);
} finally {
  await browser.close();
}
await r.finish();
