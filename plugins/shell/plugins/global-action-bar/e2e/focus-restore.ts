// Fullscreen (solo): the floating action bar collapses once the pointer leaves,
// even when a popover opened from it was closed by the keyboard. Closing a
// popover after any key (typing in it, Escape) restores focus to its trigger
// inside the bar, and Chrome marks that focus `:focus-visible` — which used to
// read as "the user tabbed in" and keep the bar expanded until the next click.
//
// Hovers the bar, opens Improve, types, presses Escape, moves the pointer away,
// and checks focus was restored into the bar as `:focus-visible` (the trigger)
// and that the bar then collapsed.
// Also checks the mouse-only path (outside click). Writes `<out>-escape.png`.
//
// Usage:
//   ./equin run plugins/shell/plugins/global-action-bar/e2e/focus-restore.ts \
//     [--out /tmp/focus-restore]

import {
  arg,
  pageUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const out = arg("out") ?? "/tmp/focus-restore";
const url = pageUrl();
const BAND = ".floating-bar-band.right-3";

const barState = (page: Page) =>
  page.evaluate((band) => {
    const wrapper = document.querySelector(`${band} .group\\/fa`);
    const active = document.activeElement;
    return {
      open: wrapper?.hasAttribute("data-open") ?? null,
      focusInBar: !!(wrapper && active && wrapper.contains(active)),
      focusVisible: active?.matches(":focus-visible") ?? false,
    };
  }, BAND);

await withBrowser(async (h) => {
  const t = report("floating bar collapses after keyboard-closed popover");
  const { page } = await h.session({ viewport: { width: 1400, height: 900 } });
  await page.goto(url);
  // Fullscreen (solo) is the boot mode, where the bar floats.
  await page.locator(BAND).waitFor({ state: "attached", timeout: 30_000 });
  await page.waitForTimeout(2000);
  const band = await page.locator(BAND).boundingBox();
  if (!band) throw new Error("floating bar band has no box");

  const hover = async () => {
    await page.mouse.move(band.x + band.width - 10, band.y + band.height / 2);
    await page.waitForTimeout(500);
  };
  const leave = async () => {
    await page.mouse.move(600, 600, { steps: 5 });
    await page.mouse.move(10, 450, { steps: 5 });
    await page.waitForTimeout(800);
  };
  const improve = page.getByRole("button", { name: /Improve/ }).first();

  await leave();
  t.eq("rests collapsed", (await barState(page)).open, false);

  // Mouse only: open Improve, dismiss with an outside click.
  await hover();
  await improve.click();
  await page.waitForTimeout(600);
  await page.mouse.click(600, 600);
  await leave();
  t.eq("mouse-only: collapses", (await barState(page)).open, false);

  // Keyboard close: type in the popover, Escape, then leave.
  await hover();
  await improve.click();
  await page.waitForTimeout(600);
  await page.keyboard.type("x");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // The scenario: Escape restored keyboard-visible focus into the bar.
  const restored = await barState(page);
  t.ok(
    "escape: focus restored into the bar, :focus-visible",
    restored.focusInBar && restored.focusVisible,
    JSON.stringify(restored),
  );
  await leave();
  const s = await barState(page);
  t.note(JSON.stringify(s));
  t.eq("escape: collapses once the pointer leaves", s.open, false);
  await snap(page, out, "escape");
  await t.finish();
});
