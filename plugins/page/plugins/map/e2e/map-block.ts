// Drives the `/map` block end to end: a page with two located places and a map
// shows two pins; clicking a pin scrolls to its place block and selects it; the
// map survives a reload.
//
// The places are PASTED as markdown rather than searched: a branch cannot search
// Places (the Places key lives on central, which runs main's code), and a
// `<place … lat lng/>` tag is exactly what a resolved place serializes to, so
// the map sees the same data a real pick would have written.
//
// Without a browser key configured the honest end is the map's own set-up
// action, not pins — the script asserts that instead and stops there.
//
// Usage:
//   ./singularity run plugins/page/plugins/map/e2e/map-block.ts [--url http://<worktree>.localhost:9000] [--headed]

import {
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  highlightedLines,
  openBlankPage,
} from "@plugins/page/plugins/editor/e2e";
import { clickPin, listedPins } from "@plugins/map/e2e";
import type { Locator, Page } from "playwright";

const OUT = "/tmp/map-block";
const r = report("map block");

const FETCHED = new Date("2026-09-01T00:00:00.000Z").toISOString();
const PLACES = [
  {
    name: "Louvre Museum",
    address: "Rue de Rivoli, Paris",
    lat: 48.8606,
    lng: 2.3376,
  },
  {
    name: "Eiffel Tower",
    address: "Champ de Mars, Paris",
    lat: 48.8584,
    lng: 2.2945,
  },
];

/**
 * The document: two places, a pile of filler paragraphs, then the map — so the
 * first place is scrolled OUT of view while the map is on screen, and a pin
 * click has something to reveal.
 */
const MARKDOWN = [
  ...PLACES.map(
    (p, i) =>
      `<place name="${p.name}" address="${p.address}" lat="${p.lat}" lng="${p.lng}" provider="google" place-id="e2e-${i}" fetched="${FETCHED}"/>`,
  ),
  ...Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i + 1}.`),
  "<map/>",
].join("\n\n");

/** Fire a synthetic paste at the focused block: multi-line text lands as a parsed block forest. */
async function pasteMarkdown(block: Locator, text: string): Promise<void> {
  await block.evaluate((el: Element, md: string) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", md);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

/** The map block's row: the one holding either pins or the map's set-up action. */
function mapRow(page: Page): Locator {
  return page
    .locator("[data-block-id]")
    .filter({
      has: page.locator(
        '[data-map-pins], button:has-text("Set up the live map")',
      ),
    })
    .last();
}

async function inViewport(page: Page, el: Locator): Promise<boolean> {
  const box = await el.boundingBox();
  const vp = page.viewportSize();
  if (box === null || vp === null) return false;
  return box.y + box.height > 0 && box.y < vp.height;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "light" });

  const doc = await openBlankPage(page, { settleMs: 500 });
  r.note(`blank page ${doc.pageUrl}`);

  await pasteMarkdown(doc.block, MARKDOWN);
  await page.waitForTimeout(1500);

  const row = mapRow(page);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.scrollIntoViewIfNeeded();
  // Pins arrive after the Maps script loads from Google — give it time before
  // deciding which arm this deploy is on.
  await page.waitForTimeout(4000);
  await snap(page, OUT, "1-map");

  const setup = row.getByRole("button", { name: "Set up the live map" });
  if (await setup.isVisible()) {
    r.ok("no browser key: the map offers its set-up action", true);
    r.note("stopping before pins — configure a browser key to exercise them");
    return;
  }

  // Pins are drawn on one canvas; the map lists them in a hidden list.
  await listedPins(page)
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  r.eq("two located places render two pins", await listedPins(page).count(), 2);

  // The first place sits 30 paragraphs above the map, off screen.
  const louvreRow = page
    .locator("[data-block-id]")
    .filter({ hasText: PLACES[0]!.name })
    .first();
  r.ok(
    "setup: the first place is off screen while the map is shown",
    !(await inViewport(page, louvreRow)),
  );

  await clickPin(page, PLACES[0]!.name);
  await page.waitForTimeout(1200); // smooth scroll
  await snap(page, OUT, "2-after-pin-click");
  r.ok(
    "clicking a pin scrolls its place block into view",
    await inViewport(page, louvreRow),
  );
  r.ok(
    "clicking a pin selects its place block",
    (await highlightedLines(page)) >= 1,
  );

  // Read back from the server: the optimistic overlay renders the pasted blocks
  // whether or not the writes landed.
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = mapRow(page);
  await reloaded.waitFor({ state: "visible", timeout: 30_000 });
  await reloaded.scrollIntoViewIfNeeded();
  await page.waitForTimeout(4000);
  await snap(page, OUT, "3-after-reload");
  r.eq(
    "the map and its pins survive a reload",
    await listedPins(page).count(),
    2,
  );
});

await r.finish();
