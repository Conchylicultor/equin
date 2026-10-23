// Fullscreen (solo) safe area: the floating action bar publishes
// `--floating-bar-safe-area` while it floats, and the surface-edge header
// reserves that much room on its right, so the collapsed bar no longer sits on
// top of the header's actions.
//
// Docks the app first (solo is the boot mode: through the floating bar's gear),
// checks no var is published docked, switches to Fullscreen (solo) through
// the gear's Layout control, then checks the var is published and that no
// header control in the top band reaches under the collapsed bar, and that the
// bar is centred on the anchored header's line — also after that header is
// made taller. Then opens the app gallery (Home, a surface with no top header,
// so no anchor) through the app launcher and checks the bar is still painted
// and hit-testable at the corner. Writes `<out>-docked.png`, `<out>-solo.png`,
// `<out>-solo-tall.png`, `<out>-solo-home.png`.
//
// Usage:
//   ./singularity run plugins/shell/plugins/global-action-bar/e2e/solo-safe-area.ts \
//     [--path /agents/c/<id>] [--out /tmp/solo-safe-area]

import {
  arg,
  pageUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openFloatingActionBar } from "./support/open-floating-bar";

const out = arg("out") ?? "/tmp/solo-safe-area";
// A surface with a top header (the bar centres on it); `/` lands on Home,
// which has none.
const url = pageUrl("/agents");

const readVar = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--floating-bar-safe-area")
      .trim(),
  );

/** Left edge of the collapsed floating bar, and the right edge of the
 *  rightmost in-flow control sharing its vertical band (a strip BELOW the bar
 *  is not under it, however far right it reaches). */
const measure = (page: Page) =>
  page.evaluate(() => {
    const fixedAncestor = (el: Element) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return n;
      }
      return null;
    };
    const bar: DOMRect[] = [];
    const rest: DOMRect[] = [];
    for (const b of document.querySelectorAll("button, [role=button]")) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // The surface frame itself is `fixed` in solo; the bar is the small fixed
      // box hugging the viewport's top-right corner.
      const fixed = fixedAncestor(b)?.getBoundingClientRect();
      const isBar =
        fixed != null &&
        fixed.right > window.innerWidth - 40 &&
        fixed.top < 40 &&
        fixed.width < window.innerWidth / 2;
      (isBar ? bar : rest).push(r);
    }
    const barLeft = Math.min(...bar.map((r) => r.left));
    const barTop = Math.min(...bar.map((r) => r.top));
    const barBottom = Math.max(...bar.map((r) => r.bottom));
    const headerRight = Math.max(
      -Infinity,
      ...rest
        .filter((r) => r.bottom > barTop && r.top < barBottom)
        .map((r) => r.right),
    );
    // The header the bar is anchored to: the box carrying the anchor name.
    const anchors = [...document.querySelectorAll(".anchor-floating-bar-band")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const header = anchors.at(-1);
    const barCenter = (barTop + barBottom) / 2;
    const headerCenter = header ? (header.top + header.bottom) / 2 : NaN;
    return { barLeft, barTop, barBottom, headerRight, barCenter, headerCenter };
  });

await withBrowser(async (h) => {
  const t = report("solo safe area");
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await page.goto(url);
  // The bar's gear — not a DataView toolbar's own "View options" button.
  const gear = page.locator('[data-ui-owner^="ViewOptionsButton@"]');
  await gear.waitFor();

  // Solo is the boot mode: dock through the floating bar's gear first.
  await openFloatingActionBar(page);
  await gear.click();
  await page
    .getByRole("radio", { name: "Dock in tab strip", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  t.eq("docked: no safe area published", await readVar(page), "");
  await snap(page, out, "docked");

  await gear.click();
  await page
    .getByRole("radio", { name: "Fullscreen (solo)", exact: true })
    .click();
  await page.mouse.click(700, 600); // dismiss the popover; rest the bar collapsed
  await page.mouse.move(10, 450);
  await page.waitForTimeout(1000);

  const solo = await readVar(page);
  t.ok("solo: safe area published", solo !== "", JSON.stringify(solo));
  t.note(`--floating-bar-safe-area: ${solo}`);
  const m = await measure(page);
  t.note(`bar left ${m.barLeft}px, header right ${m.headerRight}px`);
  t.ok(
    "solo: header controls clear the collapsed bar",
    m.headerRight <= m.barLeft,
    JSON.stringify(m),
  );
  t.note(`bar centre ${m.barCenter}px, header centre ${m.headerCenter}px`);
  t.ok(
    "solo: bar centred on the header line (±1px)",
    Math.abs(m.barCenter - m.headerCenter) <= 1,
    JSON.stringify(m),
  );

  await snap(page, out, "solo");

  // Change the header's height and check the bar follows with no re-render.
  await page.evaluate(() => {
    const els = [
      ...document.querySelectorAll<HTMLElement>(".anchor-floating-bar-band"),
    ];
    const last = els
      .filter((el) => el.getBoundingClientRect().height > 0)
      .at(-1);
    if (last) last.style.height = "72px";
  });
  await page.waitForTimeout(300);
  const tall = await measure(page);
  t.note(
    `72px header: bar centre ${tall.barCenter}px, header centre ${tall.headerCenter}px`,
  );
  t.ok(
    "solo: bar follows a taller header (±1px)",
    Math.abs(tall.barCenter - tall.headerCenter) <= 1,
    JSON.stringify(tall),
  );
  await snap(page, out, "solo-tall");

  // A surface with no header names no anchor: the band must fall back to the
  // corner, not disappear (a `position-anchor` naming a missing anchor makes
  // Chrome skip painting and hit-testing the box while its rects look fine).
  await page
    .getByRole("button", { name: "All apps", exact: true })
    .first()
    .click();
  await page.mouse.move(700, 600);
  await page.waitForTimeout(1000);
  const homeHit = await page.evaluate(() => {
    // The bar's own band (the one holding the health dot) — not its
    // pointer-events-none home slot, nor another chrome piece on the band.
    const band = [...document.querySelectorAll(".floating-bar-band")].find(
      (el) => el.querySelector("[data-health]"),
    );
    const r = band?.getBoundingClientRect();
    if (!band || !r) return { mounted: false, hit: false };
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + 4);
    return { mounted: true, hit: at != null && band.contains(at) };
  });
  t.ok("home: bar mounted", homeHit.mounted, JSON.stringify(homeHit));
  t.ok(
    "home: bar painted and hit-testable",
    homeHit.hit,
    JSON.stringify(homeHit),
  );
  await snap(page, out, "solo-home");
  await t.finish();
});
