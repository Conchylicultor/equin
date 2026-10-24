// Filter presets and the side panel on THIS checkout's deploy:
//
// 1. a tag picked on All places makes it dirty; Save as preset makes a new
//    preset (right after All places, renamed inline) holding the filter;
// 2. another tag makes the new preset dirty; Update saves it (clean again);
// 3. a tag more, then switching to All places, resets the preset with a
//    toast whose Undo brings the edit back (and the preset); Reset drops it;
// 4. ⌥1 / ⌥2 switch presets;
// 5. dragging the new preset above All places leaves All places first;
// 6. zooming the map changes the panel's "In view" count;
// 7. hovering a row in the panel lifts its pin;
// 8. a row click drills the place's card into the panel; Back returns;
// 9. folding the sidebar keeps its header, titled by the active preset; unfolding brings it back.
//
// The preset it makes is deleted at the end. Needs saved places with tags (run
// `tour.ts` first on an empty deploy).
//
// Usage:
//   ./equin run plugins/apps/plugins/places/plugins/places-map/e2e/presets.ts \
//     [--name "E2E preset"] [--out /tmp/places-presets]
//
// Writes `<out>-<step>.png`; exits non-zero on the first broken expectation.

import type { Locator, Page } from "playwright";
import {
  arg,
  pathUrl,
  snap,
  TOAST,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { liftedPin } from "@plugins/map/e2e";

const out = arg("out", "/tmp/places-presets");
const presetName = arg("name", "E2E preset");

/** The sidebar's preset rows, in order (`data-view-id`). */
const presetRows = (page: Page): Locator =>
  page.locator("[data-view-id]:visible");

async function presetOrder(page: Page): Promise<string[]> {
  return presetRows(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-view-id") ?? ""),
  );
}

/**
 * The active preset's row id: the selected row (`Row` marks its control
 * `aria-current` — the row itself, or, on a row with a ⋯ menu, the button
 * inside the row's box that carries `data-view-id`).
 */
async function activePreset(page: Page): Promise<string> {
  const id = await page
    .locator(
      "[data-view-id][aria-current]:visible, [data-view-id]:has([aria-current]):visible",
    )
    .first()
    .getAttribute("data-view-id");
  if (id === null) throw new Error("no active preset row");
  return id;
}

/** A clickable tag row of the tree (a click toggles off ↔ include), by index. */
const tagRow = (page: Page, i: number): Locator =>
  page.locator("[data-tag-row]").nth(i);

const button = (page: Page, name: string): Locator =>
  page.getByRole("button", { name, exact: true });

function expect(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
  console.log(`✓ ${what}`);
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByPlaceholder("Search or add places")
    .waitFor({ timeout: 30_000 });
  // The sidebar open, the panel a list, All places active.
  if (await button(page, "Expand sidebar").isVisible())
    await button(page, "Expand sidebar").click();
  if (await page.getByRole("button", { name: /^Show the list/ }).isVisible())
    await page.getByRole("button", { name: /^Show the list/ }).click();
  await page.locator('[data-view-id="all"]').click();
  await page.waitForTimeout(2500);
  await snap(page, out, "start");

  // 1. Dirty home → Save as preset.
  await tagRow(page, 0).click();
  await button(page, "Save as preset").waitFor({ timeout: 10_000 });
  expect(
    (await page
      .locator('[data-view-id="all"] [aria-label="Unsaved changes"]')
      .count()) === 1,
    "a tag picked on All places makes it dirty",
  );
  await snap(page, out, "home-dirty");
  await button(page, "Save as preset").click();
  const rename = page.getByLabel("View name");
  await rename.waitFor({ timeout: 10_000 });
  await rename.fill(presetName);
  await rename.press("Enter");
  await page.waitForTimeout(800);
  const order = await presetOrder(page);
  const newId = order[1];
  if (newId === undefined)
    throw new Error(`no preset after All places: ${order.join(", ")}`);
  expect(
    (await page.locator(`[data-view-id="${newId}"]`).innerText()).includes(
      presetName,
    ),
    `the new preset "${presetName}" sits right after All places`,
  );
  expect(
    (await page
      .locator('[data-view-id="all"] [aria-label="Unsaved changes"]')
      .count()) === 0,
    "All places went back to its saved filter",
  );
  await snap(page, out, "saved-as-preset");

  // 2. Dirty → Update.
  await tagRow(page, 1).click();
  await button(page, "Update").waitFor({ timeout: 10_000 });
  await snap(page, out, "preset-dirty");
  await button(page, "Update").click();
  await page.waitForTimeout(800);
  expect(
    !(await button(page, "Update").isVisible()),
    "Update saves the preset (clean again)",
  );

  // 3. Dirty → switch → toast → Undo → Reset.
  await tagRow(page, 2).click();
  await button(page, "Reset").waitFor({ timeout: 10_000 });
  await page.locator('[data-view-id="all"]').click();
  const toast = page
    .locator(TOAST)
    .filter({ hasText: "reset to its saved filter" });
  await toast.waitFor({ timeout: 10_000 });
  await snap(page, out, "switch-toast");
  await toast.getByRole("button", { name: "Undo" }).click();
  await button(page, "Reset").waitFor({ timeout: 10_000 });
  expect(true, "Undo brings the edit back on the preset");
  await button(page, "Reset").click();
  await page.waitForTimeout(500);
  expect(!(await button(page, "Reset").isVisible()), "Reset drops the edit");

  // 4. ⌥1 / ⌥2.
  await page.locator("body").click({ position: { x: 720, y: 500 } });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+Digit1");
  await page.waitForTimeout(500);
  const first = await activePreset(page);
  await page.keyboard.press("Alt+Digit2");
  await page.waitForTimeout(500);
  const second = await activePreset(page);
  expect(first === "all" && second === newId, "⌥1 / ⌥2 switch presets");

  // 5. Drag the new preset above All places: All places stays first.
  const from = page.locator(`[data-view-id="${newId}"]`);
  const to = page.locator('[data-view-id="all"]');
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error("preset rows not on screen");
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, b.y + 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect(
    (await presetOrder(page))[0] === "all",
    "All places stays first after a drag above it",
  );

  // 6. Zooming the map changes "In view".
  await page.locator('[data-view-id="all"]').click();
  await page.waitForTimeout(1000);
  const inView = page
    .getByRole("radio", { name: /^In view/ })
    .or(page.getByRole("button", { name: /^In view/ }));
  const before = await inView.first().innerText();
  const map = page.locator(".gm-style").first();
  const box = await map.boundingBox();
  if (box === null) throw new Error("no map on the page");
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2000);
  const after = await inView.first().innerText();
  await snap(page, out, "zoomed");
  expect(
    before !== after,
    `zooming changes the in-view count (${before} → ${after})`,
  );
  // Back out, so rows are in view.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2000);

  // 7. Row hover lifts the pin.
  const row = page.locator("[data-row-key]").first();
  await row.waitFor({ timeout: 10_000 });
  const label = (await row.innerText()).split("\n")[0]?.trim() ?? "";
  await row.hover();
  await page.waitForTimeout(600);
  await snap(page, out, "row-hover");
  expect(
    await liftedPin(page, label).isVisible(),
    `hovering the row "${label}" lifts its pin`,
  );

  // 8. Drill + Back.
  await row.click();
  const back = page.getByRole("button", { name: /· (in view|all)$/ });
  await back.waitFor({ timeout: 10_000 });
  await page.getByLabel("Note", { exact: true }).waitFor({ timeout: 30_000 });
  await snap(page, out, "drilled");
  expect(true, "a row click drills the card into the panel");
  await back.click();
  await page.locator("[data-row-key]").first().waitFor({ timeout: 10_000 });
  expect(!(await back.isVisible()), "Back returns to the list");

  // 9. Fold → the header names the preset → unfold.
  await button(page, "Collapse sidebar").click();
  await button(page, "Expand sidebar").waitFor({ timeout: 10_000 });
  await snap(page, out, "collapsed");
  expect(
    await page.locator('[aria-label^="View: "]').first().isVisible(),
    "folded: the header's title is the preset dropdown",
  );
  expect(
    !(await page.locator("[data-tag-row]").first().isVisible()),
    "folded: the tag tree is gone",
  );
  await button(page, "Expand sidebar").click();
  await tagRow(page, 0).waitFor({ timeout: 10_000 });

  // Clean up: delete the preset, from its row's ⋯ (shown on the active row).
  // The pointer leaves the top-left corner first: resting there opens the app
  // launcher's grid over the sidebar.
  await page.mouse.move(720, 600);
  await page.waitForTimeout(500);
  const own = page.locator(`[data-view-id="${newId}"]`);
  await own.click();
  await own.getByRole("button", { name: `${presetName} actions` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.waitForTimeout(800);
  expect(
    !(await presetOrder(page)).includes(newId),
    "the test preset is deleted",
  );
});
