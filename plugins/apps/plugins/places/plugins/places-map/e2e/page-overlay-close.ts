// The page overlay is a VIEW of the one map pane (`/places;page=<pageId>`), on
// THIS checkout's deploy: closing it (×) and reopening it (browser back) only
// change the pane's `;page` param — the URL goes to `/places` and back, the
// panel goes and comes back, and the map is never remounted: the SAME map DOM
// node stays connected and a flag set on `window` survives (no reload). Then a
// page's map block's "Open in Places" lands on `/places;page=<pageId>`.
//
// Needs a page with Google place blocks and a `/map` block on this deploy's
// database (`--page`, default one of the dev DB's).
//
// Usage:
//   ./equin run plugins/apps/plugins/places/plugins/places-map/e2e/page-overlay-close.ts \
//     [--page <pageId>] [--out /tmp/places-page-overlay]
//
// Writes `<out>-<step>.png`; exits non-zero on any broken expectation.

import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const pageId = arg("page", "block-638c6312-ceb1-40fe-971e-fef9b3f6c7dd");
const out = arg("out", "/tmp/places-page-overlay");
const r = report("places page overlay: close / back / open from Pages");

const OVERLAY_PATH = `/places;page=${pageId}`;

/** The overlay panel's own chip: present exactly while the layer is on. */
const panelChip = (page: Page) =>
  page.getByText("From a page", { exact: true }).first();

/** The address bar's path (a keyed param is part of it: `/places;page=x`). */
const pathOf = (page: Page) => decodeURIComponent(new URL(page.url()).pathname);

/** Whether the map node tagged at the start is still THE map, and the window flag still set. */
async function sameMap(page: Page): Promise<{ node: boolean; flag: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __e2eMapNode?: Element;
      __e2eFlag?: string;
    };
    const tagged = w.__e2eMapNode;
    return {
      node:
        tagged !== undefined &&
        tagged.isConnected &&
        document.querySelector("[data-e2e-map]") === tagged,
      flag: w.__e2eFlag === "kept",
    };
  });
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });

  // 1. Open the overlay cold.
  await page.goto(pathUrl(OVERLAY_PATH));
  await page
    .getByPlaceholder("Search or add places")
    .waitFor({ timeout: 30_000 });
  await panelChip(page).waitFor({ timeout: 30_000 });
  const map = page.locator(".gm-style").first();
  await map.waitFor({ timeout: 30_000 });
  // The page's places in the panel (its title line and summary) have landed.
  await page
    .getByText(/\d+ places?$/)
    .first()
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "open");
  r.eq("opened at the overlay URL", pathOf(page), OVERLAY_PATH);
  r.ok("overlay panel shown", await panelChip(page).isVisible());

  // 2. Tag the map's node and the window: a remount replaces the one, a
  //    reload drops the other.
  await map.evaluate((el: Element) => {
    el.setAttribute("data-e2e-map", "1");
    const w = window as unknown as {
      __e2eMapNode?: Element;
      __e2eFlag?: string;
    };
    w.__e2eMapNode = el;
    w.__e2eFlag = "kept";
  });

  // 3. × closes the layer: `;page` cleared on the same mounted pane.
  await page
    .getByRole("button", { name: "Close the page — back to your map" })
    .click();
  await panelChip(page).waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForTimeout(800);
  await snap(page, out, "closed");
  r.eq("closed: URL is the bare map", pathOf(page), "/places");
  r.ok("closed: panel gone", !(await panelChip(page).isVisible()));
  const afterClose = await sameMap(page);
  r.ok("closed: the SAME map node is still connected", afterClose.node);
  r.ok("closed: window flag intact (no reload)", afterClose.flag);

  // 4. Back reopens the layer, still on the same map.
  await page.goBack();
  await panelChip(page).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await snap(page, out, "back");
  r.eq("back: URL has ;page again", pathOf(page), OVERLAY_PATH);
  r.ok("back: panel shown", await panelChip(page).isVisible());
  const afterBack = await sameMap(page);
  r.ok("back: the SAME map node is still connected", afterBack.node);
  r.ok("back: window flag intact (no reload)", afterBack.flag);

  // 5. From Pages: the map block's "Open in Places" lands on the overlay.
  await page.goto(pathUrl(`/pages/page/${pageId}`));
  const blockMap = page.locator(".gm-style").first();
  await blockMap.waitFor({ timeout: 30_000 });
  await blockMap.scrollIntoViewIfNeeded();
  await blockMap.hover();
  const open = page.getByRole("button", { name: "Open in Places" }).first();
  await open.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await snap(page, out, "page-block");
  await open.click();
  await panelChip(page).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "from-pages");
  r.eq("Open in Places: lands on the overlay URL", pathOf(page), OVERLAY_PATH);
  r.ok(
    "Open in Places: overlay panel shown",
    await panelChip(page).isVisible(),
  );

  await r.finish();
});
