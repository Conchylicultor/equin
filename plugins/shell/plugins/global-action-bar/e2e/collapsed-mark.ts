// The collapsed floating bar's mark: the health dot, ringed while a background
// activity runs (`ActionBar.Activity`), with glance chips (`ActionBar.Glance`,
// e.g. Reload) beside it. Open, the dot is the plain health button again: no
// ring, no glance chip — the expanded row's items say it themselves.
//
// Opens the app, switches to Fullscreen (solo) so the bar floats collapsed, and
// photographs the mark at rest. With `--wait-ring <s>` it then waits that long
// for a ring to appear (start a build in parallel) and photographs it. Last it
// hovers the bar open and checks the dot lost its ring and no glance chip shows.
// Writes `<out>-rest.png`, `<out>-ring.png`, `<out>-open.png` (cropped to the
// bar's corner).
//
// Usage:
//   ./equin run plugins/shell/plugins/global-action-bar/e2e/collapsed-mark.ts \
//     [--path /agents] [--out /tmp/collapsed-mark] [--wait-ring 600]

import {
  arg,
  pageUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const out = arg("out") ?? "/tmp/collapsed-mark";
const waitRing = Number(arg("wait-ring") ?? "0");
const url = pageUrl();

const health = (page: Page) => page.locator("[data-health]").last();

/** The top-right corner the floating bar lives in. */
async function corner(page: Page, name: string): Promise<void> {
  const width = page.viewportSize()?.width ?? 1400;
  await page.screenshot({
    path: `${out}-${name}.png`,
    clip: { x: width - 420, y: 0, width: 420, height: 64 },
  });
  console.log(`wrote ${out}-${name}.png`);
}

await withBrowser(async (h) => {
  const t = report("collapsed mark");
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await page.goto(url);
  const gear = page
    .getByRole("button", { name: "View options", exact: true })
    .first();
  // Solo is the boot mode, where the gear sits inside the collapsed floating
  // bar: open it first (a real pointer move, see below).
  await health(page).waitFor();
  const dot = await health(page).boundingBox();
  if (!dot) throw new Error("health button has no box");
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.waitForTimeout(600);
  await gear.click();
  await page
    .getByRole("radio", { name: "Fullscreen (solo)", exact: true })
    .click();
  await page.mouse.click(700, 600); // dismiss the popover; rest the bar collapsed
  await page.mouse.move(10, 450);
  await page.waitForTimeout(1200);

  t.note(`health button: ${await health(page).getAttribute("aria-label")}`);
  await corner(page, "rest");

  if (waitRing > 0) {
    const ring = health(page).locator("svg circle").first();
    const appeared = await ring
      .waitFor({ state: "attached", timeout: waitRing * 1000 })
      .then(() => true)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return false;
        throw err;
      });
    t.ok("a ring appears while an activity runs", appeared);
    if (appeared) {
      await page.waitForTimeout(400);
      t.note(`ringed: ${await health(page).getAttribute("aria-label")}`);
      await corner(page, "ring");
    }
  }

  // Open the bar: the dot reverts to the plain health button (no ring, no
  // glance chip — the row carries the same information).
  // A real pointer move, not locator.hover(): the floating panel's own layer
  // sits over the trigger and would make hover() wait forever.
  const box = await health(page).boundingBox();
  if (!box) throw new Error("health button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  t.note(`open: ${await health(page).getAttribute("aria-label")}`);
  t.ok(
    "open: the health dot has no ring",
    (await health(page).locator("svg circle").count()) === 0,
  );
  // At most one Reload: the row's own segment, never the glance chip beside it.
  const reloads = await page
    .getByRole("button", { name: /reload/i })
    .evaluateAll(
      (els) => els.filter((el) => el.getBoundingClientRect().width > 0).length,
    );
  t.ok("open: no glance chip is visible", reloads <= 1);
  await corner(page, "open");
  await t.finish();
});
