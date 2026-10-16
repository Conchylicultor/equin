// A tour of the Places app on THIS checkout's deploy: saves a few places
// through the real Add place flow (Google Places search → pick), then captures
// the map, the sidebar's Restaurants filter included then excluded (logging
// the map's marks and the sidebar counts at each step), a selected place's
// card, the Gallery and List views and the tag manager. Needs the Google Maps Places key configured; without it the search
// popover shows the set-up action and the script stops there.
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/tour.ts \
//     [--out /tmp/places] [--queries "Septime Paris;Musée Rodin Paris"] [--skip-add]
//
// Writes `<out>-<step>.png`. Saving is idempotent per Google place
// (`already-saved`), so re-running only re-captures.

import {
  arg,
  flag,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { clickPin, pinsOnScreen } from "@plugins/map/e2e";

const out = arg("out", "/tmp/places");
const queries = arg(
  "queries",
  "Septime Paris;Musée Rodin Paris;Du Pain et des Idées Paris;Jardin du Luxembourg;Le Baratin Paris;Shakespeare and Company Paris",
)
  .split(";")
  .map((q) => q.trim())
  .filter((q) => q !== "");
const skipAdd = flag("skip-add");

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await page.goto(pathUrl("/places"));
  await page
    .getByRole("button", { name: "Add place", exact: true })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "start");

  if (!skipAdd) {
    for (const q of queries) {
      await page
        .getByRole("button", { name: "Add place", exact: true })
        .click();
      const input = page.getByRole("textbox", { name: "Search Google Places" });
      await input.waitFor();
      await input.fill(q);
      // The query's longest word is in the first suggestion's primary line
      // (a short word like "Le" would also match unrelated buttons).
      const word = q
        .split(" ")
        .filter((w) => w !== "Paris")
        .reduce((a, b) => (b.length > a.length ? b : a), "");
      const pick = page.getByRole("button").filter({ hasText: word }).first();
      const appeared = await pick
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "TimeoutError") return false;
          throw err;
        });
      if (!appeared) {
        await snap(page, out, "search-no-result");
        throw new Error(`no suggestion containing "${word}" for "${q}"`);
      }
      await pick.click();
      await page.waitForTimeout(2500);
      await snap(page, out, `added-${word.toLowerCase()}`);
      await page.keyboard.press("Escape");
    }
  }

  await page.waitForTimeout(3000);
  await snap(page, out, "map");

  // The sidebar's tag filter: Restaurants → include → exclude → off. Each step
  // logs what the map shows (pins and clusters by their accessible names) and
  // the sidebar's counts, so a change is visible in the output, not only in
  // the screenshots.
  const restaurants = page
    .getByTitle("Click to include, again to exclude")
    .filter({ hasText: "Restaurants" })
    .first();
  const report = async (step: string) => {
    const marks = (await pinsOnScreen(page, { atLeastOne: false })).map(
      (p) => p.label,
    );
    const rows = await page
      .getByTitle("Click to include, again to exclude")
      .allInnerTexts();
    console.log(`[${step}] map marks: ${JSON.stringify(marks)}`);
    console.log(
      `[${step}] sidebar: ${rows.map((r) => r.replace(/\s+/g, " ").trim()).join(" | ")}`,
    );
  };
  await report("all");
  for (const step of ["filter-include", "filter-exclude", "filter-clear"]) {
    await restaurants.click();
    await page.waitForTimeout(2000);
    await report(step);
    if (step !== "filter-clear") await snap(page, out, step);
  }

  const pin = (await pinsOnScreen(page, { atLeastOne: false })).find((p) =>
    p.label.includes("Septime"),
  );
  if (pin !== undefined) {
    await clickPin(page, pin.label);
    await page.waitForTimeout(1500);
    await snap(page, out, "selected");
  }

  for (const view of ["Gallery", "List"]) {
    const tab = page
      .getByRole("button", { name: view, exact: true })
      .or(page.getByRole("tab", { name: view, exact: true }));
    await tab.first().click();
    await page.waitForTimeout(1500);
    await snap(page, out, view.toLowerCase());
  }

  await page.getByRole("button", { name: "Manage tags" }).first().click();
  await page.waitForTimeout(1500);
  await snap(page, out, "manage");
});
