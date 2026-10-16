// The map's camera is the user's, on THIS checkout's deploy: after the user
// zooms, a tag filter that keeps places, one that matches none, and clearing it
// again must neither move the map nor unmount it (the sidebar's count reading
// "0 / N" when nothing matches); only the Fit button reframes, flying there.
// Pin screen positions are the camera's witness — an unchanged camera leaves
// every still-shown pin exactly where it was. Needs saved places with a
// location (run `tour.ts` first on an empty deploy), at least one tag that
// keeps some (`--keep`, default "Status") and one that keeps none
// (`--none`, default "Done").
//
// Usage:
//   ./singularity run plugins/apps/plugins/places/plugins/places-map/e2e/camera-stays.ts \
//     [--keep Status] [--none Done] [--out /tmp/places-camera]
//
// Writes `<out>-<step>.png`; exits non-zero on the first broken expectation.

import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { pinsOnScreen } from "@plugins/map/e2e";

const out = arg("out", "/tmp/places-camera");
const keepTag = arg("keep", "Status");
const noneTag = arg("none", "Done");

/** Every map mark (pin or cluster) drawn at the last camera rest, by its label, at its screen point. */
async function marks(page: Page): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const p of await pinsOnScreen(page, { atLeastOne: false })) {
    found.set(p.label, `${Math.round(p.x)},${Math.round(p.y)}`);
  }
  return found;
}

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

  const map = page.locator(".gm-style").first();
  const box = await map.boundingBox();
  if (box === null) throw new Error("no map on the page");

  // Start from no tag filter: the view's filter is saved, so a previous
  // session's picks would otherwise leak into the steps below.
  const clear = page.getByRole("button", { name: "Clear", exact: true });
  if (await clear.isVisible()) await clear.click();

  // The user's own framing: zoom out a few notches over the map's middle.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1500);
  await snap(page, out, "user-framing");
  const before = await marks(page);
  if (before.size === 0) throw new Error("no map marks after zooming");
  console.log(`[user-framing] ${before.size} mark(s)`);

  // The sidebar's tree row for a tag: its name button.
  const tagRow = (name: string) =>
    page
      .getByRole("button")
      .filter({ hasText: new RegExp(`^${name}\\s*\\d*$`) })
      .first();

  const expectUnmoved = async (step: string) => {
    await page.waitForTimeout(1500);
    await snap(page, out, step);
    if (!(await map.isVisible())) throw new Error(`${step}: the map is gone`);
    const now = await marks(page);
    for (const [label, at] of now) {
      const was = before.get(label);
      if (was !== undefined && was !== at) {
        throw new Error(`${step}: "${label}" moved ${was} → ${at}`);
      }
    }
    console.log(`[${step}] map shown, ${now.size} mark(s), none moved ✓`);
    return now;
  };

  await tagRow(keepTag).click();
  const kept = await expectUnmoved(`include-${keepTag}`);
  if (kept.size === 0) throw new Error(`"${keepTag}" left no marks`);
  await tagRow(keepTag).click(); // include → exclude
  await tagRow(keepTag).click(); // exclude → off
  await expectUnmoved(`cleared-${keepTag}`);

  await tagRow(noneTag).click();
  const none = await expectUnmoved(`include-${noneTag}`);
  if (none.size !== 0)
    throw new Error(`"${noneTag}" still shows ${none.size} mark(s)`);
  // A bare map: no card over it — the sidebar's count says why.
  const count = page.getByLabel(/^0 of \d+ places shown$/);
  if (!(await count.isVisible()))
    throw new Error('no "0 / N" count in the sidebar');
  console.log(
    `[include-${noneTag}] sidebar reads ${await count.textContent()} ✓`,
  );
  await tagRow(noneTag).click();
  await tagRow(noneTag).click();
  await expectUnmoved(`cleared-${noneTag}`);

  // Fit is the one thing that reframes.
  // Fit flies rather than jumps: frames caught mid-flight differ from both ends.
  await page.getByRole("button", { name: "Fit to the map's places" }).click();
  for (const ms of [150, 350, 550]) {
    await page.waitForTimeout(ms === 150 ? 150 : 200);
    await snap(page, out, `fit-${ms}ms`);
  }
  await page.waitForTimeout(1500);
  await snap(page, out, "fit");
  const fitted = await marks(page);
  const moved = [...fitted].some(([l, at]) => {
    const was = before.get(l);
    return was === undefined || was !== at;
  });
  if (!moved) throw new Error("Fit did not reframe the map");
  console.log(`[fit] reframed, ${fitted.size} mark(s) ✓`);
});
