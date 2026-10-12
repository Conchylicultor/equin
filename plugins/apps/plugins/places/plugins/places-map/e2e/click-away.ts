// The place card's click-away on THIS checkout's deploy: select a pin, then
// check that panning the map keeps the card, that selecting another pin swaps
// it, that a click on the card itself keeps it, and that a click on the bare
// map closes it. Needs at least two saved places with a location (run
// `tour.ts` first on an empty deploy).
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/click-away.ts \
//     [--out /tmp/places-click-away]
//
// Writes `<out>-<step>.png`; exits non-zero on the first broken expectation.

import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/places-click-away");

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByRole("button", { name: "Add place", exact: true })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);

  // The card's only stable handle: its heading row's Close button.
  const card = page.getByRole("button", { name: "Close", exact: true });
  const expectCard = async (open: boolean, step: string) => {
    await page.waitForTimeout(800);
    await snap(page, out, step);
    const shown = await card.isVisible();
    if (shown !== open) {
      throw new Error(
        `${step}: expected the card ${open ? "open" : "closed"}, it is ${shown ? "open" : "closed"}`,
      );
    }
    console.log(`[${step}] card ${shown ? "open" : "closed"} ✓`);
  };

  // Map pins: the saved-place drops, not the clusters (whose names are counts).
  const pins = page.locator('[role="button"][aria-label]').filter({
    has: page.locator('[role="img"]'),
  });
  const count = await pins.count();
  if (count < 2) throw new Error(`need two visible pins, found ${count}`);

  await pins.nth(0).click();
  await expectCard(true, "selected");

  // A click inside the card (its hero) keeps it.
  const hero = card.locator("xpath=..");
  await hero.click({ position: { x: 4, y: 4 } });
  await expectCard(true, "click-in-card");

  // A pan of the map is a drag, not a click away.
  const map = page.locator(".gm-style").first();
  const box = await map.boundingBox();
  if (box === null) throw new Error("no map on the page");
  const mid = { x: box.x + box.width / 2, y: box.y + box.height - 120 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 80, mid.y - 30, { steps: 8 });
  await page.mouse.up();
  await expectCard(true, "after-pan");

  // Selecting another pin swaps the card's place; it stays open.
  await pins.nth(1).click();
  await expectCard(true, "other-pin");

  // A click on the bare map (bottom middle, away from the chrome) closes it.
  await page.mouse.click(mid.x, mid.y);
  await expectCard(false, "click-away");
});
