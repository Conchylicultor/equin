// The wheel over a pin zooms the map on THIS checkout's deploy, as it does over
// the bare map — the pin keeps presses and clicks, never the wheel. Drives the
// Places map (any page with two visible pins would do): wheel in with the
// cursor on a pin and check the two pins moved apart. Needs at least two saved
// places with a location (run the places-map `tour.ts` first on an empty deploy).
//
// Usage:
//   ./singularity run plugins/map/plugins/google/e2e/wheel-over-pin.ts \
//     [--out /tmp/map-wheel-over-pin]
//
// Writes `<out>-<step>.png`; exits non-zero when the map did not zoom.

import {
  arg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/map-wheel-over-pin");

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

  // Map pins and clusters: the overlay buttons inside Google's map.
  const pins = page.locator('.gm-style [role="button"][aria-label]');
  const count = await pins.count();
  if (count < 2) throw new Error(`need two visible pins, found ${count}`);

  // Followed by label, not index: a zoom can re-cluster and reorder them.
  const [labelA, labelB] = await Promise.all([
    pins.nth(0).getAttribute("aria-label"),
    pins.nth(1).getAttribute("aria-label"),
  ]);
  const centre = async (label: string | null) => {
    const box = await page
      .locator(`.gm-style [role="button"][aria-label="${label}"]`)
      .first()
      .boundingBox();
    if (box === null) throw new Error(`pin "${label}" has no box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const spread = async () => {
    const [a, b] = await Promise.all([centre(labelA), centre(labelB)]);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  await snap(page, out, "before");
  const before = await spread();
  const first = await centre(labelA);
  await page.mouse.move(first.x, first.y);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1500);
  await snap(page, out, "after");
  const after = await spread();

  console.log(`pin spread ${before.toFixed(0)}px → ${after.toFixed(0)}px`);
  if (!(after > before * 1.2)) {
    throw new Error("wheel over a pin did not zoom the map in");
  }
  console.log("wheel over a pin zooms the map ✓");
});
