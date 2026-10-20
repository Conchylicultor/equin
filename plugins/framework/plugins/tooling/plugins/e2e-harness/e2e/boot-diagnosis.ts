/**
 * What the page was showing when `boot()` gave up on its marker.
 *
 * A bare Playwright `waitFor` timeout says only that the selector never became
 * visible — not whether the app was still loading (a spinner up, a request in
 * flight), had rendered the element at a zero-size box, or had settled on
 * something else entirely (an error, "not found"). Those call for different
 * fixes, and a flake that passes on the next run leaves nothing else to go on.
 * So the timeout is re-thrown carrying the page's state at that moment, plus
 * whatever the caller knows how to read about its own app (`describe`).
 */
import type { Page } from "playwright";
import { inflightUrls } from "./network-idle";

/** How the page looked: one line per signal, ready to print. */
export async function describeBootStall(
  page: Page,
  marker: string,
  describe?: (page: Page) => Promise<string>,
): Promise<string[]> {
  const seen = await page.evaluate((sel) => {
    const boxOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return `${String(Math.round(r.width))}×${String(Math.round(r.height))}`;
    };
    const squash = (text: string, max: number) => {
      const t = text.replace(/\s+/g, " ").trim();
      return t.length > max ? `${t.slice(0, max)}…` : t;
    };
    const matches = [...document.querySelectorAll(sel)];
    const busy = [...document.querySelectorAll('[aria-busy="true"]')].map(
      (el) =>
        squash(
          el.getAttribute("aria-label") ?? (el.textContent || el.tagName),
          60,
        ),
    );
    return {
      matches: matches.length,
      firstBox: matches[0] ? boxOf(matches[0]) : null,
      busy,
      text: squash(document.body.innerText, 300),
    };
  }, marker);
  const lines = [
    `url: ${page.url()}`,
    seen.matches === 0
      ? "marker: no element matches"
      : `marker: ${String(seen.matches)} match(es), never visible (first box ${seen.firstBox ?? "?"})`,
    seen.busy.length === 0
      ? "loading: nothing aria-busy on the page"
      : `loading: ${String(seen.busy.length)} aria-busy region(s): ${seen.busy.slice(0, 5).join(" | ")}`,
  ];
  const inflight = inflightUrls(page);
  if (inflight !== null) {
    lines.push(
      inflight.length === 0
        ? "network: nothing in flight"
        : `network: ${String(inflight.length)} request(s) in flight: ${inflight.slice(0, 5).join(", ")}`,
    );
  }
  lines.push(`page text: ${seen.text === "" ? "(empty)" : `"${seen.text}"`}`);
  if (describe) lines.push(await describe(page));
  return lines;
}
