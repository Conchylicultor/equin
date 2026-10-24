// The dialog's BOX, checked against a real layout engine — the four things
// about it that no type and no jsdom test can answer, because each one is a
// question about where pixels actually land.
//
// The first is the load-bearing one: a press on the dim area beside a dialog
// closes it.
//
// It is invisible because nothing about `DialogContent` says "dismissible" —
// base-ui grants that for free, and the only way to LOSE it is for the dialog's
// own box to be bigger than the panel you can see. It shipped that way for
// months (a `fixed inset-0` popup with the panel centred inside it): base-ui
// asks "did the press land inside the floating element?", the floating element
// was the whole window, so every press answered yes and Escape was the only way
// out. A type cannot see that, and a jsdom test cannot either — "is this point
// inside that box" is a question only a real layout engine answers. So it is
// checked here, against the deployed app.
//
// The other three are the chrome and placement changes that followed: the
// corner ✕ (a dialog must offer an exit the user can SEE), the capped top
// offset (a bare `20vh` drifts down a tall display without limit), and the
// side margin at phone width (the box must not run edge to edge).
//
// Two subjects, each picked for being reachable on a fresh page with no data:
// the ⌘K command palette (opens from a keystroke; deliberately has NO ✕,
// because its footer already says `esc close`), and the Pages sidebar's Trash
// dialog (opens from one click; carries the default ✕).
//
// Usage:
//   ./equin run plugins/primitives/plugins/css/plugins/ui-kit/e2e/dialog-box.ts

import {
  DEFAULT_VIEWPORT,
  ELEMENT_TIMEOUT_MS,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  waitForNetworkIdle,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/dialog-box";
const PANEL = '[data-slot="dialog-panel"]';
const POPUP = '[data-slot="dialog-content"]';
const CLOSE = '[data-slot="dialog-close-corner"]';

/** What the popup's own offset resolves to: `min(20vh, 8rem)` at 16px/rem. */
const expectedTop = (viewportHeight: number): number =>
  Math.min(0.2 * viewportHeight, 128);

const r = report("dialog box");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/"));
  await waitForNetworkIdle(page);

  const panel = page.locator(PANEL).first();
  const panelCount = (): Promise<number> => page.locator(PANEL).count();

  async function openPalette(tag: string): Promise<void> {
    await page.keyboard.press("ControlOrMeta+k");
    await panel.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
    r.note(`${tag}: palette open`);
  }

  /** Closed, or the deadline passed — either way a fact to assert on. */
  const closed = (): Promise<{ ok: boolean }> =>
    waitFor(panelCount, (n) => n === 0, { timeoutMs: 5_000 });

  await openPalette("1");
  await snap(page, OUT, "1-open");

  // The popup is what base-ui measures "outside" against, so the regression is
  // stated directly: its box must be the panel's box, not the window's.
  const boxes = await page.evaluate(
    (sel) => {
      const popup = document.querySelector(sel.popup);
      const panelEl = document.querySelector(sel.panel);
      if (!popup || !panelEl) return null;
      const p = popup.getBoundingClientRect();
      const q = panelEl.getBoundingClientRect();
      return {
        popup: { w: p.width, h: p.height },
        panel: { w: q.width, h: q.height },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    },
    { popup: POPUP, panel: PANEL },
  );
  if (!boxes) {
    r.fail("popup and panel are both in the DOM");
  } else {
    r.note(
      `popup ${Math.round(boxes.popup.w)}x${Math.round(boxes.popup.h)} · ` +
        `panel ${Math.round(boxes.panel.w)}x${Math.round(boxes.panel.h)} · ` +
        `viewport ${boxes.viewport.w}x${boxes.viewport.h}`,
    );
    r.ok(
      "the dialog's box is no taller than the panel it shows",
      boxes.popup.h <= boxes.panel.h + 1,
      `popup ${boxes.popup.h}px vs panel ${boxes.panel.h}px — a taller popup is dead area that swallows the press`,
    );
    r.ok(
      "the dialog's box does not span the window",
      boxes.popup.h < boxes.viewport.h,
      `popup ${boxes.popup.h}px vs viewport ${boxes.viewport.h}px`,
    );
  }

  // The behaviour itself: press the dim area well clear of the panel.
  await page.mouse.click(12, 12);
  r.ok(
    "a press beside the panel closes the dialog",
    (await closed()).ok,
    "the dialog was still open after clicking the backdrop",
  );
  await snap(page, OUT, "2-after-outside-press");

  // Escape must still work — the fix moved layout, and a popup that stopped
  // taking focus would lose the keyboard path without anything else changing.
  await openPalette("2");
  await page.keyboard.press("Escape");
  r.ok(
    "Escape still closes the dialog",
    (await closed()).ok,
    "the dialog was still open after Escape",
  );

  // A press INSIDE the panel must not close it — the half a naive
  // "click anywhere closes" fix would break, and the reason this asserts both.
  await openPalette("3");
  const box = await panel.boundingBox();
  if (!box) {
    r.fail("the open panel has a box to press inside");
  } else {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const stayed = await waitFor(panelCount, (n) => n === 0, {
      timeoutMs: 1_000,
    });
    r.ok(
      "a press inside the panel leaves the dialog open",
      !stayed.ok,
      "the dialog closed on a press on its own content",
    );
  }

  // ── Placement: the offset is capped, not a bare fraction of the window ────
  // Asserted at two heights because ONE height cannot tell a cap from a
  // percentage — they agree wherever 20vh happens to be under the cap. The
  // short window is where the proportional half must still apply, the tall one
  // is where the cap must bite; a bare `20vh` fails the second, a bare `8rem`
  // fails the first.
  for (const height of [500, 1200]) {
    await page.setViewportSize({ width: 1280, height });
    const top = await panel.boundingBox().then((b) => b?.y ?? -1);
    const want = expectedTop(height);
    r.ok(
      `at ${height}px tall the dialog sits ${Math.round(want)}px from the top`,
      Math.abs(top - want) <= 2,
      `got ${Math.round(top)}px, want ~${Math.round(want)}px`,
    );
  }

  // ── Placement: the box never runs past the bottom edge ────────────────────
  await page.setViewportSize({ width: 1280, height: 500 });
  const bottomGap = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return -1;
    return window.innerHeight - el.getBoundingClientRect().bottom;
  }, POPUP);
  r.ok(
    "the dialog keeps clearance above the bottom of a short window",
    bottomGap > 0,
    `the box ends ${Math.round(-bottomGap)}px PAST the bottom edge`,
  );

  // ── Placement: a side margin at phone width ───────────────────────────────
  await page.setViewportSize({ width: 375, height: 700 });
  const sides = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: window.innerWidth - rect.right };
  }, POPUP);
  if (!sides) {
    r.fail("the popup is in the DOM at phone width");
  } else {
    r.note(
      `phone width: ${Math.round(sides.left)}px left, ${Math.round(sides.right)}px right`,
    );
    r.ok(
      "the dialog does not run edge to edge at phone width",
      sides.left > 0 && sides.right > 0,
      `left ${Math.round(sides.left)}px, right ${Math.round(sides.right)}px`,
    );
    r.ok(
      "and it stays centred",
      Math.abs(sides.left - sides.right) <= 1,
      `left ${Math.round(sides.left)}px vs right ${Math.round(sides.right)}px`,
    );
  }
  await snap(page, OUT, "3-phone-width");
  await page.keyboard.press("Escape");
  await page.setViewportSize(DEFAULT_VIEWPORT);

  // ── The corner ✕ ──────────────────────────────────────────────────────────
  // The palette opts OUT, because its footer already says `esc close`. Checking
  // that here is what keeps the default honest: if the button were unconditional
  // the opt-out would be dead, and nobody would notice.
  await openPalette("4");
  r.ok(
    "a dialog that shows its own way out gets no second one",
    (await page.locator(CLOSE).count()) === 0,
    "the command palette rendered a corner ✕ on top of its `esc close` footer",
  );
  await page.keyboard.press("Escape");
  await closed();

  // The Pages Trash dialog takes the default, so it carries the ✕.
  await page.goto(pathUrl("/pages"));
  await waitForNetworkIdle(page);
  await page.getByText("Trash", { exact: true }).first().click();
  await panel.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await snap(page, OUT, "4-close-button");

  const closeButton = page.locator(CLOSE).first();
  r.ok(
    "a dialog with no exit of its own gets the corner ✕",
    (await page.locator(CLOSE).count()) === 1,
    "no corner ✕ on a default dialog — Escape and the outside press are the only exits, and both are invisible",
  );

  // Inside the panel's box, so it must not be mistaken for an outside press —
  // and it must actually close, not merely be present.
  const panelBox = await panel.boundingBox();
  const closeBox = await closeButton.boundingBox();
  if (!panelBox || !closeBox) {
    r.fail("the ✕ and the panel both have boxes");
  } else {
    r.ok(
      "the ✕ sits inside the panel's top-right corner",
      closeBox.x > panelBox.x + panelBox.width / 2 &&
        closeBox.y >= panelBox.y - 1 &&
        closeBox.y < panelBox.y + panelBox.height / 2,
      `✕ at (${Math.round(closeBox.x)}, ${Math.round(closeBox.y)}) vs panel at (${Math.round(panelBox.x)}, ${Math.round(panelBox.y)}) ${Math.round(panelBox.width)}x${Math.round(panelBox.height)}`,
    );
  }

  await closeButton.click();
  r.ok(
    "the ✕ closes the dialog",
    (await closed()).ok,
    "the dialog was still open after pressing its own close button",
  );
});

await r.finish();
