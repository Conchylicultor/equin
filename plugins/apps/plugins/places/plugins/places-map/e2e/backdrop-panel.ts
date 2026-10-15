// The map is the Places surface's backdrop, on THIS checkout's deploy: Gallery
// and List float over it as a card instead of replacing it. Checks that
// switching to Gallery, then List (a view with a row order), keeps the map
// mounted under the card, that coming back
// to the map finds the user's camera where it was (pins at the same screen
// positions), and that opening a place from the gallery moves the card's right
// edge clear of the place card. Needs saved places with a location (run
// `tour.ts` first on an empty deploy).
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/backdrop-panel.ts \
//     [--map "All places"] [--gallery Gallery] [--list List] [--out /tmp/places-backdrop]
//
// Writes `<out>-<step>.png`; exits non-zero on the first broken expectation.

import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/places-backdrop");
const mapTab = arg("map", "All places");
const galleryTab = arg("gallery", "Gallery");
const listTab = arg("list", "List");

/** Every visible map mark (pin or cluster) by its label, at its screen centre. */
async function marks(page: Page): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const nodes = page.locator(".gm-style [role='button'][aria-label]");
  for (const node of await nodes.all()) {
    const label = await node.getAttribute("aria-label");
    const box = await node.boundingBox();
    if (label === null || box === null) continue;
    found.set(
      label,
      `${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`,
    );
  }
  return found;
}

/** The floating view card's box: the inset layer holding the gallery's cards. */
async function viewCard(
  page: Page,
): Promise<{ left: number; right: number; top: number; bottom: number }> {
  const card = page.locator("[data-row-key]").first();
  await card.waitFor({ timeout: 30_000 });
  return card.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node !== null && node.style.bottom === "") node = node.parentElement;
    if (node === null) throw new Error("the gallery is not inside a card");
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

const tab = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).first();

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByRole("button", { name: "Add place", exact: true })
    .waitFor({ timeout: 30_000 });
  await tab(page, mapTab).click();
  await page.waitForTimeout(3000);

  const map = page.locator(".gm-style").first();
  const box = await map.boundingBox();
  if (box === null) throw new Error("no map on the page");

  // The user's own framing.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1500);
  const before = await marks(page);
  if (before.size === 0) throw new Error("no map marks after zooming");
  const mapNode = await map.elementHandle();
  await snap(page, out, "map");

  // Gallery: a card over the same, still-mounted map.
  await tab(page, galleryTab).click();
  const card = await viewCard(page);
  await page.waitForTimeout(1000);
  await snap(page, out, "gallery");
  if (!(await map.isVisible())) throw new Error("gallery: the map is gone");
  if (!(await mapNode!.evaluate((el) => el.isConnected)))
    throw new Error("gallery: the map was remounted");
  if (card.bottom > 900 - 4 || card.right > 1440 - 4)
    throw new Error(`gallery: the card is not inset (${JSON.stringify(card)})`);
  console.log(`[gallery] card ${JSON.stringify(card)} over the map ✓`);

  // List: a view with a manual row order — the switch must not remount the map.
  await tab(page, listTab).click();
  await page.waitForTimeout(1000);
  await snap(page, out, "list");
  if (!(await mapNode!.evaluate((el) => el.isConnected)))
    throw new Error("list: the map was remounted");
  console.log("[list] same map under the card ✓");

  // Back to the map: the camera is where the user left it.
  await tab(page, mapTab).click();
  await page.waitForTimeout(1500);
  await snap(page, out, "map-again");
  const after = await marks(page);
  for (const [label, at] of after) {
    const was = before.get(label);
    if (was !== undefined && was !== at)
      throw new Error(`map-again: "${label}" moved ${was} → ${at}`);
  }
  console.log(`[map-again] ${after.size} mark(s), none moved ✓`);

  // Open a place from the gallery: the view card yields to the place card.
  await tab(page, galleryTab).click();
  await page.locator("[data-row-key]").first().click();
  const note = page.getByLabel("Note", { exact: true });
  await note.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await snap(page, out, "gallery-card");
  const placeCard = await note.evaluate((el) => {
    // The place card's pin: the nearest positioned ancestor that is a card
    // (narrower than half the screen), not a full-surface layer.
    let node: HTMLElement | null = el as HTMLElement;
    while (node !== null) {
      const r = node.getBoundingClientRect();
      if (
        getComputedStyle(node).position === "absolute" &&
        r.width < window.innerWidth / 2
      )
        return r.left;
      node = node.parentElement;
    }
    throw new Error("the place card is not pinned");
  });
  const yielded = await viewCard(page);
  if (yielded.right > placeCard)
    throw new Error(
      `gallery-card: the view card (right ${yielded.right}) runs under the place card (left ${placeCard})`,
    );
  console.log(
    `[gallery-card] view card ends at ${Math.round(yielded.right)}, place card starts at ${Math.round(placeCard)} ✓`,
  );
});
