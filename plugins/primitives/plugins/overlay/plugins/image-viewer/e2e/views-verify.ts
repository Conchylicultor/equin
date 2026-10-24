// Drives the viewer's three views over a folder of images in the Files app: the
// docked thumbnail strip, the grid (tile slider, arrow keys, Enter), and the
// control-less slideshow — and checks each one's visible state plus no page
// errors.
//
// Usage:
//   ./equin run plugins/primitives/plugins/overlay/plugins/image-viewer/e2e/views-verify.ts \
//     --file </files/at/… route of an image in a folder of ≥ 3 images> [--out /tmp/image-viewer-views]

import {
  arg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const file = requireArg(
  "file",
  "views-verify.ts --file </files/at/… route of an image in a folder of ≥ 3 images> [--out <dir>]",
);
const OUT = arg("out", "/tmp/image-viewer-views");
const r = report("image viewer views");

await withBrowser(async (h) => {
  const { page, captured } = await h.session({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(pathUrl(file));

  const preview = page.locator('img[aria-haspopup="dialog"]').first();
  await preview.waitFor({ timeout: 30_000 });
  await preview.click();
  const dialog = page.getByRole("dialog", { name: /^Image viewer/ });
  await dialog.waitFor({ timeout: 5000 });
  await page.waitForTimeout(600);
  const stageImg = dialog.locator("img[data-viewer-stage]");
  const counter = () => dialog.getByText(/^\d+ \/ \d+$/).textContent();
  const pressed = (name: string) =>
    dialog
      .getByRole("button", { name, exact: true })
      .getAttribute("aria-pressed");

  // Start from a known state: the strip preference is remembered per device.
  if ((await pressed("Thumbnail strip")) === "true") {
    await page.keyboard.press("s");
    await page.waitForTimeout(400);
  }
  const strip = dialog.getByRole("group", { name: "All images" });

  // --- strip ---------------------------------------------------------------
  const without = await stageImg.boundingBox();
  await dialog
    .getByRole("button", { name: "Thumbnail strip", exact: true })
    .click();
  await page.waitForTimeout(500);
  r.eq(
    "the strip button reads pressed",
    await pressed("Thumbnail strip"),
    "true",
  );
  r.ok("the strip docks along the bottom", (await strip.count()) === 1);
  const withStrip = await stageImg.boundingBox();
  r.ok(
    "the image refits into the room above the strip",
    !!without &&
      !!withStrip &&
      withStrip.y + withStrip.height <= without.y + without.height,
    `without=${JSON.stringify(without)} with=${JSON.stringify(withStrip)}`,
  );
  const current = strip.locator('button[aria-current="true"]');
  r.eq("one strip thumbnail is current", await current.count(), 1);
  await snap(page, OUT, "1-strip");

  const before = await counter();
  await strip.locator("button").nth(2).click();
  await page.waitForTimeout(500);
  r.ok(
    "a strip thumbnail jumps to its image",
    (await counter())?.startsWith("3 /") ?? false,
    `before=${before} after=${await counter()}`,
  );

  // --- grid ----------------------------------------------------------------
  await page.keyboard.press("g");
  await page.waitForTimeout(400);
  const grid = dialog.getByRole("group", { name: "All images" });
  const tiles = grid.locator("[data-grid-tile]");
  r.ok("G opens the grid of every image", (await tiles.count()) >= 3);
  // Every tile on screen should finish loading quickly: tiles draw resized
  // copies, never the originals.
  const loadStart = Date.now();
  const visibleLoaded = () =>
    grid.evaluate((el) => {
      const view = el.closest("[role=dialog]")!.getBoundingClientRect();
      const imgs = [...el.querySelectorAll("img")].filter((img) => {
        const b = img.getBoundingClientRect();
        return b.bottom > view.top && b.top < view.bottom;
      });
      return {
        total: imgs.length,
        done: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      };
    });
  let loaded = await visibleLoaded();
  while (loaded.done < loaded.total && Date.now() - loadStart < 30_000) {
    await page.waitForTimeout(250);
    loaded = await visibleLoaded();
  }
  const loadMs = Date.now() - loadStart;
  r.ok(
    "every tile on screen loads within 2 s",
    loaded.done === loaded.total && loadMs < 2000,
    `${loaded.done}/${loaded.total} in ${loadMs} ms`,
  );
  const originals = await grid.evaluate(
    (el) =>
      [...el.querySelectorAll("img")].filter(
        (img) =>
          // A lazy tile far off screen has not picked a source yet.
          img.currentSrc !== "" &&
          !img.currentSrc.includes("/api/host-fs/image/resized"),
      ).length,
  );
  r.eq("every grid tile draws a resized copy", originals, 0);

  // ⌘-scroll over a tile resizes the grid around it: the tile stays put.
  const anchorTile = tiles.nth(1);
  const anchorBox = await anchorTile.boundingBox();
  if (anchorBox) {
    await page.mouse.move(anchorBox.x + 20, anchorBox.y + 20);
    await page.keyboard.down("Meta");
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -20);
    await page.keyboard.up("Meta");
    await page.waitForTimeout(200);
    const after = await anchorTile.boundingBox();
    r.ok(
      "⌘-scroll grows the tiles and keeps the tile under the pointer in place",
      !!after &&
        after.width > anchorBox.width &&
        Math.abs(after.y - anchorBox.y) < 4,
      `before=${JSON.stringify(anchorBox)} after=${JSON.stringify(after)}`,
    );
  }
  r.eq(
    "the slider replaces the zoom controls",
    await dialog.getByRole("slider", { name: "Thumbnail size" }).count(),
    1,
  );
  const columns = () =>
    grid.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
  const wide = await columns();
  await page.keyboard.press("-");
  await page.keyboard.press("-");
  await page.waitForTimeout(200);
  const narrow = await columns();
  r.ok(
    "− shrinks the tiles: more columns",
    narrow > wide,
    `${wide} → ${narrow}`,
  );
  await snap(page, OUT, "2-grid");

  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(150);
  r.ok(
    "← moves the selection",
    (await counter())?.startsWith("2 /") ?? false,
    `${await counter()}`,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  r.eq("Enter opens the selected image", await tiles.count(), 0);
  r.ok(
    "…on its own",
    (await counter())?.startsWith("2 /") ?? false,
    `${await counter()}`,
  );

  // --- an instant step --------------------------------------------------------
  // With the neighbours decoded ahead, → swaps the image in the same frame or
  // the next, and the stage never goes transparent in between.
  const stripCopies = await strip.evaluate(
    (el) =>
      [...el.querySelectorAll("img")].filter(
        (img) =>
          img.currentSrc !== "" &&
          !img.currentSrc.includes("/api/host-fs/image/resized"),
      ).length,
  );
  r.eq("every strip thumbnail draws a resized copy", stripCopies, 0);
  await page.waitForTimeout(1500);
  const step = await page.evaluate(
    () =>
      new Promise<{ ms: number; srcMs: number; minOpacity: number }>(
        (resolve) => {
          const img = document.querySelector<HTMLImageElement>(
            "img[data-viewer-stage]",
          )!;
          const from = img.getAttribute("src");
          const t0 = performance.now();
          let minOpacity = 1;
          let srcMs = Infinity;
          new MutationObserver(() => {
            srcMs = Math.min(srcMs, performance.now() - t0);
          }).observe(img, { attributes: true, attributeFilter: ["src"] });
          const sample = () => {
            minOpacity = Math.min(
              minOpacity,
              Number(getComputedStyle(img).opacity),
            );
            if (img.getAttribute("src") !== from && img.complete) {
              resolve({ ms: performance.now() - t0, srcMs, minOpacity });
              return;
            }
            if (performance.now() - t0 > 5000)
              resolve({ ms: Infinity, srcMs, minOpacity });
            else requestAnimationFrame(sample);
          };
          document.activeElement?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
          );
          requestAnimationFrame(sample);
        },
      ),
  );
  r.ok(
    "→ paints the next image within 100 ms, with no fade",
    step.ms < 100 && step.minOpacity === 1,
    `painted ${step.ms.toFixed(0)} ms (src set at ${step.srcMs.toFixed(0)} ms), min opacity ${step.minOpacity}`,
  );
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);

  // --- slideshow -----------------------------------------------------------
  await page.keyboard.press("f");
  await page.waitForTimeout(700);
  const fullscreen = await page.evaluate(
    () => document.fullscreenElement !== null,
  );
  const chrome = await dialog
    .locator("[data-chrome]")
    .getAttribute("data-chrome");
  if (fullscreen) {
    r.eq("the slideshow hides every control", chrome, "hidden");
    await snap(page, OUT, "3-slideshow");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
    r.ok(
      "→ steps in the slideshow",
      (await counter())?.startsWith("3 /") ?? false,
    );
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForTimeout(500);
    r.eq(
      "leaving full screen brings the controls back",
      await dialog.locator("[data-chrome]").getAttribute("data-chrome"),
      "shown",
    );
  } else {
    r.ok(
      "headless refused full screen: the viewer says so and keeps its controls",
      (await dialog.getByText("Full screen isn't allowed here").count()) ===
        1 && chrome === "shown",
    );
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  r.eq("Esc closes the viewer", await dialog.count(), 0);
  r.eq("no page errors", captured.pageErrors, []);
  await r.finish();
});
