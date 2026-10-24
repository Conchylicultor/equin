// Drives the image viewer in a real conversation: open a transcript image, zoom,
// drag, click back to fit, step to the next image, click to close, reopen, Esc —
// and checks each step's visible state (zoom readout, counter, focus) plus no
// page errors.
//
// Usage:
//   ./equin run plugins/primitives/plugins/overlay/plugins/image-viewer/e2e/viewer-verify.ts \
//     --conv <conversation id with ≥ 2 transcript images> [--out /tmp/image-viewer]

import {
  pathUrl,
  report,
  requireArg,
  arg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const conv = requireArg(
  "conv",
  "viewer-verify.ts --conv <conversation id with ≥ 2 transcript images> [--out <dir>]",
);
const OUT = arg("out", "/tmp/image-viewer");
const r = report("image viewer");

await withBrowser(async (h) => {
  const { page, captured } = await h.session({
    viewport: { width: 1400, height: 900 },
  });
  await page.goto(pathUrl(`/agents/c/${conv}`));

  const thumbs = page.getByRole("button", { name: /^View image / });
  await thumbs.first().waitFor({ timeout: 30_000 });
  // Let the transcript finish rendering its images.
  await page.waitForTimeout(2000);
  const count = await thumbs.count();
  r.ok(
    "transcript shows at least two image thumbnails",
    count >= 2,
    `found ${count}`,
  );

  const dialog = page.getByRole("dialog", { name: /^Image viewer/ });
  const zoom = async () => {
    const text = await dialog.getByText(/^\d+%$/).textContent();
    return Number(text?.replace("%", ""));
  };
  const counter = () => dialog.getByText(/^\d+ \/ \d+$/).textContent();
  // The viewer's own image: the first <img> in the dialog (the minimap's comes later).
  const stageImg = dialog.locator("img").first();
  // "At fit" is the Fit button pressed — wait for it rather than a fixed delay:
  // the readout passes through the thumbnail's scale while the image grows out
  // of it, and on a loaded host that animation can outlast any sleep.
  const atFit = () =>
    dialog
      .locator('button[aria-pressed="true"]', { hasText: "Fit" })
      .waitFor({ timeout: 10_000 });

  const first = thumbs.first();
  await first.scrollIntoViewIfNeeded();
  const urlBefore = page.url();
  await first.click();
  await dialog.waitFor({ timeout: 5000 });
  await atFit();
  await page.waitForTimeout(400);
  const fit = await zoom();
  r.ok("opens fitted, never above 100%", fit > 0 && fit <= 100, `fit=${fit}%`);
  r.eq("counter starts at the clicked image", await counter(), `1 / ${count}`);
  await snap(page, OUT, "1-fit");

  // A point on the viewer's image that is also on screen (a zoomed image
  // overflows the window, so its box's own centre may not be).
  const onImage = async () => {
    const box = await stageImg.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) return null;
    const left = Math.max(box.x, 0);
    const top = Math.max(box.y, 0);
    const right = Math.min(box.x + box.width, view.width);
    const bottom = Math.min(box.y + box.height, view.height);
    return right > left && bottom > top
      ? { x: (left + right) / 2, y: (top + bottom) / 2 }
      : null;
  };

  // + zooms past fit.
  await page.keyboard.press("+");
  await page.waitForTimeout(700);
  const zoomed = await zoom();
  r.ok("+ zooms in past fit", zoomed > fit, `fit=${fit}% → ${zoomed}%`);
  await snap(page, OUT, "2-zoomed");

  // Drag pans the zoomed image.
  const before = await stageImg.boundingBox();
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(500, 350, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await stageImg.boundingBox();
  const moved =
    !!before && !!after && (before.x !== after.x || before.y !== after.y);
  r.ok(
    "drag pans the zoomed image",
    moved,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
  r.eq("a drag does not close the viewer", await dialog.count(), 1);

  // A click on the zoomed image goes back to fit, and keeps the viewer open.
  const zoomedSpot = await onImage();
  if (!zoomedSpot) r.fail("zoomed image has an on-screen point");
  else {
    await page.mouse.click(zoomedSpot.x, zoomedSpot.y);
    await atFit();
    r.eq("click on a zoomed image returns to fit", await zoom(), fit);
    r.eq("…and keeps the viewer open", await dialog.count(), 1);
  }

  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(600);
  r.eq("→ steps to the next image", await counter(), `2 / ${count}`);
  await atFit();
  await snap(page, OUT, "3-next");

  // A click on the fitted image closes the viewer.
  const fitSpot = await onImage();
  if (!fitSpot) r.fail("fitted image has an on-screen point");
  else {
    await page.mouse.click(fitSpot.x, fitSpot.y);
    await page.waitForTimeout(600);
    r.eq(
      "click on the fitted image closes the viewer",
      await dialog.count(),
      0,
    );
  }

  // Reopen, then Esc.
  await first.click();
  await dialog.waitFor({ timeout: 5000 });
  await atFit();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  r.eq("Esc closes the viewer", await dialog.count(), 0);
  r.eq("closing changes nothing else (same URL)", page.url(), urlBefore);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? "",
  );
  r.ok(
    "focus returns to a thumbnail",
    focused.startsWith("View image "),
    `focused=${focused}`,
  );

  r.eq("no page errors", captured.pageErrors, []);
  await r.finish();
});
