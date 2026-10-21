// Verifies the canvas-wide size & zoom chip: the canvas opens at Fit at the
// size the prototype declares (`<meta name="prototype-viewport">`); Responsive
// lays the page out at the room's own size; a device preset lays every frame's page out at that device's size; Fit
// shrinks the frame to the room while 100% and the zoom slider set the scale
// exactly; Whole page makes the frame as tall as its document (nothing left to
// scroll inside); and the Width slider resizes every frame, snapping onto a
// preset it moves near and otherwise giving a Custom width.
// Manual only — nothing runs this automatically.
//
// Usage:
//   ./singularity run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-size.ts \
//     [--name <prototype id>] [--out <prefix>] [--headed]

import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  SIZE_PRESETS,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  dismiss,
  frameDoc,
  letters,
  openCanvas,
  openSizeMenu,
  pickPrototype,
  pickSize,
  screen,
  sizeChip,
  addFrame,
} from "./driver";

const out = arg("out", "/tmp/canvas-size");
const meta = await pickPrototype();
const VIEWPORT = { width: 1600, height: 1000 };

/** Frame `letter`'s logical page size and its on-screen scale. */
async function measure(
  page: Page,
  m: PrototypeMeta,
  letter: string,
): Promise<{ w: number; h: number; scale: number; boxH: number } | null> {
  const doc = await frameDoc(page, m, letter);
  const box = await screen(page, letter).boundingBox();
  if (!doc || !box) return null;
  return {
    w: doc.width,
    h: doc.height,
    scale: Math.round((box.width / doc.width) * 100) / 100,
    boxH: box.height,
  };
}

async function chipText(page: Page): Promise<string> {
  return (await sizeChip(page).innerText()).replace(/\s+/g, " ").trim();
}

await withBrowser(async (h) => {
  const r = report(`canvas size — ${meta.title} (${meta.name})`);
  const { page, captured } = await h.session({ viewport: VIEWPORT });
  await openCanvas(page, meta.name);
  const settle = (
    letter: string,
    ok: (v: NonNullable<Awaited<ReturnType<typeof measure>>>) => boolean,
  ) =>
    waitFor(
      () => measure(page, meta, letter),
      (v) => v !== null && ok(v),
      { timeoutMs: 10_000 },
    );

  const declared = meta.viewport;
  const declaredName =
    declared.kind === "preset"
      ? declared.preset
      : declared.kind === "window"
        ? "This window"
        : "Responsive";
  const opened = await chipText(page);
  r.ok(
    `opens at the declared size (${declaredName}) at Fit`,
    opened.startsWith(declaredName) && /Fit · \d+%/.test(opened),
    opened,
  );
  if (declared.kind === "preset") {
    const size = SIZE_PRESETS.find((p) => p.name === declared.preset)!;
    const at = await settle("A", (v) => v.w === size.w && v.h === size.h);
    r.ok(
      `…laying the page out at ${String(size.w)} × ${String(size.h)}`,
      at.ok,
      JSON.stringify(at.value),
    );
  }

  // This window: the page lays out at the size a page gets in this browser
  // window — the session's viewport.
  await pickSize(page, "This window");
  const own = await settle(
    "A",
    (v) => v.w === VIEWPORT.width && v.h === VIEWPORT.height,
  );
  r.ok(
    `This window lays the page out at the window's ${String(VIEWPORT.width)} × ${String(VIEWPORT.height)}`,
    own.ok,
    JSON.stringify(own.value),
  );

  await pickSize(page, "Responsive");
  const responsive = await settle("A", (v) => v.scale === 1);
  r.ok(
    "Responsive: the page lays out at the room's own size, at scale 1",
    responsive.ok &&
      responsive.value!.w > 1000 &&
      responsive.value!.w < VIEWPORT.width,
    JSON.stringify(responsive.value),
  );

  // A preset lays the page out at that device's size; Fit shrinks it to the room.
  await pickSize(page, "Phone");
  const phone = await settle("A", (v) => v.w === 390 && v.h === 844);
  r.ok(
    "Phone lays the page out at 390 × 844",
    phone.ok,
    JSON.stringify(phone.value),
  );
  r.ok(
    "…fitted into the room (the whole frame visible)",
    phone.ok && phone.value!.boxH <= VIEWPORT.height,
    JSON.stringify(phone.value),
  );
  r.ok(
    "the chip names the preset",
    /^Phone 390 × 844/.test(await chipText(page)),
    await chipText(page),
  );

  await pickSize(page, "Wide");
  const wide = await settle("A", (v) => v.w === 2560 && v.h === 1440);
  r.ok(
    "Wide at Fit is shrunk below 100%",
    wide.ok && wide.value!.scale < 1,
    JSON.stringify(wide.value),
  );
  await snap(page, out, "wide-fit");

  // 100%: the value box in the zoom row jumps to actual size.
  await openSizeMenu(page);
  await page.getByRole("button", { name: "Actual size" }).click();
  await dismiss(page);
  const actual = await settle("A", (v) => v.scale === 1);
  r.ok(
    "100% shows the page at scale 1",
    actual.ok,
    JSON.stringify(actual.value),
  );
  r.ok(
    "the chip reads 100%",
    / 100%$/.test(await chipText(page)),
    await chipText(page),
  );

  // The slider: ten steps down from 100% is 90%.
  await openSizeMenu(page);
  const slider = page.getByRole("slider", { name: "Zoom" });
  await slider.focus();
  for (let i = 0; i < 10; i++) await slider.press("ArrowLeft");
  await dismiss(page);
  const ninety = await settle("A", (v) => v.scale === 0.9);
  r.ok(
    "the zoom slider sets the scale (90%)",
    ninety.ok,
    JSON.stringify(ninety.value),
  );
  r.ok(
    "the chip reads 90%",
    / 90%$/.test(await chipText(page)),
    await chipText(page),
  );

  // Back to Fit.
  await openSizeMenu(page);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await dismiss(page);
  const fitScale = wide.value?.scale ?? -1;
  const fitAgain = await settle(
    "A",
    (v) => Math.abs(v.scale - fitScale) <= 0.01,
  );
  r.ok(
    `Fit goes back to the room's scale (${fitScale})`,
    fitAgain.ok,
    JSON.stringify(fitAgain.value),
  );

  // Whole page: the frame is as tall as its document — nothing to scroll inside.
  await pickSize(page, "Phone");
  await settle("A", (v) => v.w === 390);
  await openSizeMenu(page);
  await page.getByRole("switch", { name: /Whole page/ }).click();
  await dismiss(page);
  const whole = await waitFor(
    () =>
      screen(page, "A")
        .locator("iframe:not([aria-hidden])")
        .evaluate((el) => {
          const f = el as HTMLIFrameElement;
          return {
            frame: Number(f.getAttribute("height")),
            doc: f.contentDocument?.documentElement.scrollHeight ?? -1,
          };
        }),
    (v) => v.frame >= 844 && v.doc > 0 && v.doc <= v.frame,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "Whole page makes the frame as tall as its document",
    whole.ok,
    JSON.stringify(whole.value),
  );
  const wholeBox = await screen(page, "A").boundingBox();
  r.ok(
    "…still fitted into the room",
    wholeBox !== null && wholeBox.height <= VIEWPORT.height,
    JSON.stringify(wholeBox),
  );
  await snap(page, out, "whole-page");
  await openSizeMenu(page);
  await page.getByRole("switch", { name: /Whole page/ }).click();
  await dismiss(page);

  // The Width slider: every frame follows, snapping onto a preset near it.
  await addFrame(page);
  await waitFor(
    () => letters(page),
    (v) => v === "AB",
    { timeoutMs: 10_000 },
  );
  await pickSize(page, "Desktop");
  const desk = await settle("B", (v) => v.w === 1920);
  if (!desk.ok) throw new Error("frame B never reached Desktop");

  // Sets the range input as a pointer drag would: the native value setter
  // (React tracks the property) and an input event.
  async function slideTo(width: number): Promise<void> {
    await openSizeMenu(page);
    await page.getByRole("slider", { name: "Width" }).evaluate((el, w) => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!set) throw new Error("no value setter on HTMLInputElement");
      set.call(el, String(w));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, width);
    await dismiss(page);
  }

  await slideTo(1450);
  const snapped = await settle("B", (v) => v.w === 1440 && v.h === 900);
  r.ok(
    "sliding near 1440 snaps every frame onto Laptop",
    snapped.ok,
    JSON.stringify(snapped.value),
  );
  r.ok(
    "the chip names Laptop",
    /^Laptop/.test(await chipText(page)),
    await chipText(page),
  );

  await slideTo(1000);
  const custom = await settle("B", (v) => Math.abs(v.w - 1000) <= 2);
  r.ok(
    "sliding off the presets gives a custom width, in every frame",
    custom.ok,
    JSON.stringify(custom.value),
  );
  r.ok(
    "the chip reads Custom",
    /^Custom/.test(await chipText(page)),
    await chipText(page),
  );
  await snap(page, out, "custom");

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
