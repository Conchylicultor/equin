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
import { hoverPin, pinsOnScreen, reachablePins } from "@plugins/map/e2e";

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

  // Two distinct map pins (not clusters) from the list of pins on screen.
  const labels = [...new Set((await reachablePins(page)).map((p) => p.label))];
  const [labelA, labelB] = labels;
  if (labelA === undefined || labelB === undefined) {
    throw new Error(`need two visible pins, found ${labels.length}`);
  }

  // Followed by label, not index: a zoom can re-cluster and reorder them. The
  // list is rebuilt when the camera rests, so read it after the settle.
  const centre = async (label: string) => {
    const pin = (await pinsOnScreen(page)).find((p) => p.label === label);
    if (pin === undefined) throw new Error(`pin "${label}" is not on screen`);
    return pin;
  };
  const spread = async () => {
    const [a, b] = await Promise.all([centre(labelA), centre(labelB)]);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  await snap(page, out, "before");
  const before = await spread();
  // Hover the pin so the map lifts it, then wheel with the cursor on the
  // lifted pin: the pin keeps presses and clicks, never the wheel.
  await hoverPin(page, labelA);
  // One event: the raster map zooms a whole level on it, the vector map ~0.8
  // (a farther zoom can carry the other pin off screen).
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(1500);
  await snap(page, out, "after");
  const after = await spread();

  console.log(`pin spread ${before.toFixed(0)}px → ${after.toFixed(0)}px`);
  if (!(after > before * 1.2)) {
    throw new Error("wheel over a pin did not zoom the map in");
  }
  console.log("wheel over a pin zooms the map ✓");
});
