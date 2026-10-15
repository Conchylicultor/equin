// Titles and custom pins on THIS checkout's deploy, end to end, leaving the
// data as it found it:
//   1. a title on a Google place, typed in its card, shows on its pin and card
//      (Google's name under it), then cleared back to Google's name;
//   2. Add place › Drop a custom pin, named, dropped by a click on the map,
//      opens its card (no Google place) — then deleted.
// Needs a saved Google place named `--place` (default "Rue Sainte-Anne").
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/custom-pin.ts \
//     [--place "Rue Sainte-Anne"] [--wait 20000] [--out /tmp/places-custom-pin]
//
// Writes `<out>-<step>.png`; exits non-zero on the first broken expectation.

import type { Locator, Page } from "playwright";
import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/places-custom-pin");
const googleName = arg("place", "Rue Sainte-Anne");
const settle = Number(arg("wait", "20000"));
const TITLE = "Japantown (e2e)";
const CUSTOM = "E2E custom pin";

const pin = (page: Page, name: string) =>
  page.locator(`[role="button"][aria-label="${name}"]`).first();

async function expectVisible(
  page: Page,
  what: string,
  locator: Locator,
  visible: boolean,
): Promise<void> {
  await page.waitForTimeout(1500);
  const shown = await locator.isVisible();
  if (shown !== visible) {
    await snap(page, out, `fail-${what}`);
    throw new Error(`${what}: expected ${visible ? "shown" : "hidden"}`);
  }
  console.log(`[${what}] ${visible ? "shown" : "hidden"} ✓`);
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByRole("button", { name: "Add place", exact: true })
    .waitFor({ timeout: 120_000 });
  await page.waitForTimeout(settle);

  const search = page.getByPlaceholder("Search places");
  const deletePlace = async (name: string) => {
    await pin(page, name).click();
    await page
      .getByRole("button", { name: "Delete place", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete place", exact: true })
      .click();
    await page.waitForTimeout(3000);
  };

  // A pin an earlier, interrupted run left behind.
  await search.fill(CUSTOM);
  await page.waitForTimeout(3000);
  while (await pin(page, CUSTOM).isVisible()) {
    console.log(`deleting a leftover "${CUSTOM}"`);
    await deletePlace(CUSTOM);
  }

  // ── 1. A title over Google's name ──
  await search.fill(googleName);
  await page.waitForTimeout(3000);
  await pin(page, googleName).click();
  const nameInput = page.getByLabel("Place name", { exact: true });
  await nameInput.waitFor({ timeout: 30_000 });
  await nameInput.fill(TITLE);
  await nameInput.press("Enter");
  await expectVisible(
    page,
    "google-name-under-title",
    page.getByText(`On Google: ${googleName}`, { exact: true }),
    true,
  );
  await expectVisible(page, "pin-shows-title", pin(page, TITLE), true);
  await snap(page, out, "titled");

  // Cleared: Google's name again.
  await nameInput.fill("");
  await nameInput.press("Enter");
  await expectVisible(
    page,
    "title-cleared",
    page.getByText(`On Google: ${googleName}`, { exact: true }),
    false,
  );
  await expectVisible(
    page,
    "pin-shows-google-name",
    pin(page, googleName),
    true,
  );
  await snap(page, out, "title-cleared");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await search.fill("");
  await page.waitForTimeout(3000);

  // ── 2. A custom pin ──
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  await page.getByText("Drop a custom pin", { exact: true }).click();
  const pinName = page.getByLabel("Custom pin name", { exact: true });
  await pinName.waitFor({ timeout: 10_000 });
  await pinName.fill(CUSTOM);
  await snap(page, out, "dropping");
  const map = page.locator(".gm-style").first();
  const box = await map.boundingBox();
  if (box === null) throw new Error("no map on the page");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 60);
  await expectVisible(
    page,
    "custom-card",
    page.getByText("Custom pin — no Google place", { exact: true }),
    true,
  );
  await expectVisible(page, "custom-pin-on-map", pin(page, CUSTOM), true);
  await snap(page, out, "custom-pin");

  // Move it: the next click on the map is its new position.
  await page.getByRole("button", { name: "Move", exact: true }).click();
  // Away from the pin itself (a click on a pin is no pick).
  await page.mouse.click(
    box.x + box.width / 2 - 150,
    box.y + box.height / 2 + 150,
  );
  await expectVisible(
    page,
    "card-back-after-move",
    page.getByText("Custom pin — no Google place", { exact: true }),
    true,
  );
  await expectVisible(page, "moved-pin-on-map", pin(page, CUSTOM), true);
  await snap(page, out, "custom-moved");

  // Clean up: delete it.
  await deletePlace(CUSTOM);
  await expectVisible(page, "custom-pin-deleted", pin(page, CUSTOM), false);
  await snap(page, out, "custom-deleted");
});
