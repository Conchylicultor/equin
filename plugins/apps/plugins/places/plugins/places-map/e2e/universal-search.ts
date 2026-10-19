// The "Search or add places" bar on THIS checkout's deploy: typing filters
// your places (the panel's section and the map's pins), lists Google's hits
// around the map's view as cards with a rating, proposes each as a ghost pin,
// links a card's hover to its pin, never moves the camera, and Esc closes the
// panel keeping the query. With --save, Save on the first unsaved card saves
// it (the card turns Saved) and the toast's Undo removes it again. Needs saved
// places and the Google Maps Places key.
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/universal-search.ts \
//     [--query ramen] [--save] [--out /tmp/places-search]
//
// Writes `<out>-<step>.png`; exits non-zero on the first broken expectation.

import {
  arg,
  flag,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { pinsOnScreen } from "@plugins/map/e2e";

const out = arg("out", "/tmp/places-search");
const query = arg("query", "ramen");
const save = flag("save");

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  const input = page.getByPlaceholder("Search or add places");
  await input.waitFor({ timeout: 30_000 });
  // The map mounts after the chrome (its renderer loads lazily).
  await page
    .locator("[data-map-pins]")
    .waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForTimeout(3000);
  if (await page.getByRole("button", { name: "Add place" }).isVisible())
    throw new Error('the "Add place" button is still there');

  const where = async () =>
    new Map(
      (await pinsOnScreen(page, { atLeastOne: false })).map((p) => [
        p.label,
        `${Math.round(p.x)},${Math.round(p.y)}`,
      ]),
    );
  const before = await where();

  await input.fill(query);
  const cards = page.locator("[data-google-place-id]");
  await cards.first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "typed");

  const yours = await page.getByText(/^Your places \d+/).textContent();
  console.log(`[typed] ${yours} · ${await cards.count()} Google card(s)`);
  const rated = await cards.filter({ hasText: /★|\(\d/ }).count();
  if (rated === 0)
    console.log("[typed] no rating on any card (a downgraded rung?)");

  // Every unsaved hit with a position is a ghost pin on the map.
  // (A saved hit's own pin carries its name too, so only unsaved cards count.)
  const names = await cards
    .filter({ has: page.getByRole("button", { name: /^Save / }) })
    .evaluateAll((els) =>
      els.map((el) => el.textContent?.split("Save")[0] ?? ""),
    );
  const pins = await where();
  const ghosts = names.filter((n) => pins.has(n));
  if (ghosts.length === 0) throw new Error("no ghost pin for any Google card");
  console.log(`[ghosts] ${ghosts.length} ghost pin(s) ✓`);

  // The camera never moved: every saved pin still shown is where it was.
  for (const [label, at] of pins) {
    const was = before.get(label);
    if (was !== undefined && was !== at)
      throw new Error(`the camera moved: "${label}" ${was} → ${at}`);
  }
  console.log("[camera] unmoved ✓");

  // Card → pin: hovering a card lifts its ghost into the DOM, named.
  const first = cards.filter({ hasText: ghosts[0]! }).first();
  await first.hover();
  await page.waitForTimeout(300);
  const lifted = page.locator(`span[role="img"][aria-label="${ghosts[0]}"]`);
  if (!(await lifted.isVisible()))
    throw new Error(`hovering "${ghosts[0]}"'s card lifted no pin`);
  console.log(`[hover] card → pin "${ghosts[0]}" ✓`);
  await snap(page, out, "hover");

  if (save) {
    // Pinned by its place id: a filter on its Save button would move on to
    // the next card the moment this one turns Saved.
    const placeId = await cards
      .filter({ has: page.getByRole("button", { name: /^Save / }) })
      .first()
      .getAttribute("data-google-place-id");
    const card = page.locator(`[data-google-place-id="${placeId}"]`);
    const name = (await card.textContent())?.split("Save")[0] ?? "";
    await card.getByRole("button", { name: /^Save / }).click();
    await card.getByText("Saved", { exact: true }).waitFor({ timeout: 15_000 });
    console.log(`[save] "${name}" saved ✓`);
    await snap(page, out, "saved");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await card
      .getByRole("button", { name: /^Save / })
      .waitFor({ timeout: 15_000 });
    console.log(`[undo] "${name}" removed ✓`);
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  if (await cards.first().isVisible())
    throw new Error("Esc left the panel open");
  if ((await input.inputValue()) !== query)
    throw new Error("Esc cleared the query");
  console.log("[esc] panel closed, query kept ✓");
  await snap(page, out, "closed");
});
