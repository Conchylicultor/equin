// End-to-end regression for the URL menu's DROP arm, in a real browser.
// MANUAL ONLY — nothing runs this automatically.
//
// A paste implies focus; a DROP does not. The caret may be in another block, or
// nowhere at all — and `useForcedCaretQuery` gates the menu's `open` on DOM
// focus living inside THIS editor's root, so the drop handler has to seat the
// caret itself (`lexical.focus()`). Nothing below the browser can check that:
// tsc sees a method call, and the two ways it can go wrong are both silent —
// the menu never opens, or it opens anchored to nothing and paints at the page
// origin. And the link the drop inserts goes wherever the editor's selection
// is, so a caret that was never seated here would put it in the WRONG block.
//
// So every case here drops into a block the user is NOT standing in: focus is
// parked in the first block and the payload lands on a later one. A test that
// dropped into the already-focused block would pass with `lexical.focus()`
// deleted.
//
// Verifies:
//   A. a bare https URL dropped on an EMPTY text block opens the menu, anchored
//      at that block (not at the page origin)
//   B. the URL landed as a link in the block that was dropped on — it inserts
//      through the editor's own RangeSelection, so it is the proof that the
//      caret really landed HERE and not in the block that had focus a moment
//      ago — and Enter commits "Keep as link", closing the menu
//   C. the same URL dropped on a NON-empty block does not open the menu
//   D. a `text/uri-list`-only transfer (no `text/plain`) opens it too — the case
//      `readTransferText` exists for, and the one a link dragged out of another
//      browser tab actually produces
//
// The drops are SYNTHETIC (`new DragEvent` + a hand-built `DataTransfer`): an
// external OS drag cannot be originated from the page. Lexical's `DROP_COMMAND`
// comes off a plain `drop` listener on the editor root, so a dispatched event
// exercises the same path — but an untrusted event triggers no browser default
// action, so nothing here can assert what the native caret drop would have done.
// That half is `page/editor`'s `e2e/drop-verify.ts`.
//
// The script creates its own scratch page and deletes it on the way out.
//
// Usage:
//   ./equin run plugins/page/plugins/url-paste/e2e/url-drop-verify.ts [--url <deploy>] [--headed]
import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  editableBlocks,
  openBlankPage,
  typeLines,
} from "@plugins/page/plugins/editor/e2e";

const OUT = arg("out", "/tmp/url-drop-verify");

const MENU = '[data-caret-trigger="url-paste"]';
// `CaretTriggerMenu` puts `data-caret-trigger` on a `display:contents` wrapper,
// which has NO box of its own — so geometry is read off its first ROW.
const ROWS = `${MENU} > *`;
const URL = "https://example.com/dropped-article";
// A real `text/uri-list` is CRLF-terminated. Keeping the terminator here is the
// point: it proves the `.trim()` in url-paste's gate and the `text/plain` →
// `text/uri-list` fallback in `readTransferText` both do their job.
const URI_LIST_URL = "https://example.com/uri-list-only";

const r = report();

/** Dispatch a synthetic drop carrying `data` at a block's editing host. */
async function dropOn(
  page: Page,
  blockIndex: number,
  data: Record<string, string>,
): Promise<void> {
  await editableBlocks(page)
    .nth(blockIndex)
    .evaluate((el: Element, payload: Record<string, string>) => {
      const box = el.getBoundingClientRect();
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(payload))
        dt.setData(type, value);
      el.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
        }),
      );
    }, data);
  await page.waitForTimeout(500);
}

/**
 * Park focus in the FIRST block and the pointer out of the way.
 *
 * Both halves are load-bearing. The focus park is what makes every case a real
 * drop — into a block that is not the one holding the caret. The pointer park is
 * because a caret menu's row sets the active index on `mouseenter` by design, so
 * a cursor left resting where the menu will open fights the arrow keys.
 */
async function parkAwayFromDropTarget(page: Page): Promise<void> {
  await editableBlocks(page).nth(0).click();
  await page.keyboard.press("End");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
}

/** Every editable block's text, in document order. */
function blockTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll('[data-block-id] [contenteditable="true"]'),
    ].map((el) => (el.textContent ?? "").trim()),
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  // `networkidle` never settles — the app holds a live notifications WebSocket —
  // and a headless Chromium on a build-loaded host needs tens of seconds to boot
  // the SPA.
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);

  const doc = await openBlankPage(page, { settleMs: 3000 });

  async function destroyScratchPage(): Promise<void> {
    const status = await page.evaluate(async (id: string): Promise<number> => {
      const res = await fetch(`/api/blocks/${id}`, { method: "DELETE" });
      return res.status;
    }, doc.pageId);
    console.log(`\nscratch page deleted (HTTP ${status})`);
  }

  try {
    // Two blocks: "alpha" holds the caret for every case, the empty one below it
    // is the drop target.
    await typeLines(page, ["alpha"]);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000); // the ~1s doc → data.text projection
    r.eq("setup: alpha + an empty block", await blockTexts(page), [
      "alpha",
      "",
    ]);

    // ---- A: a URL dropped on an empty block opens the menu, anchored there ----
    await parkAwayFromDropTarget(page);
    const targetBox = await editableBlocks(page).nth(1).boundingBox();
    if (!targetBox) throw new Error("drop target has no box");

    await dropOn(page, 1, { "text/plain": URL });
    const opened = (await page.locator(MENU).count()) > 0;
    r.ok("A: the drop opened the menu", opened);
    if (!opened) await snap(page, OUT, "no-menu");
    r.eq(
      "A: 4 rows (keep as link / mention / bookmark / embed)",
      await page.locator(ROWS).count(),
      4,
    );

    const menuBox = await page.locator(ROWS).first().boundingBox();
    r.ok("A: the menu has a box", menuBox !== null);
    if (menuBox) {
      // THE failure this exists to catch: an anchor that resolved to nothing
      // paints the surface at the viewport origin.
      r.ok(
        `A: not at the page origin (${Math.round(menuBox.x)},${Math.round(menuBox.y)})`,
        menuBox.x > 0 && menuBox.y > 0,
      );
      // And it is at the TARGET block — a couple of hundred px is deliberately
      // loose (the surface flips and offsets), but the drop target sits well
      // down the page under the title, so anything anchored to the page rather
      // than to this block lands far above `targetBox.y`.
      const near =
        Math.abs(menuBox.x - targetBox.x) < 400 &&
        menuBox.y > targetBox.y - 40 &&
        menuBox.y < targetBox.y + 300;
      r.ok(
        `A: anchored at the target block (menu y=${Math.round(menuBox.y)}, block y=${Math.round(targetBox.y)})`,
        near,
      );
      if (!near) await snap(page, OUT, "menu-misplaced");
    }

    // ---- B: the link landed HERE, and Enter keeps it --------------------------
    // The insert goes through the editor's OWN RangeSelection. It can only land
    // in this block if the drop really seated the caret here — so this is the
    // caret-seating assertion, not a menu one. (And Enter reaching the menu at
    // all proves DOM focus is inside this editor: the surface is focus-less, the
    // editor's keydown is what drives it.)
    r.eq(
      "B: the URL landed in the block that was dropped on",
      await blockTexts(page),
      ["alpha", URL],
    );
    r.eq(
      "B: as a link",
      await editableBlocks(page)
        .nth(1)
        .locator("a")
        .first()
        .getAttribute("href"),
      URL,
    );
    // Row 0 is "Keep as link" — the menu opens with it active.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    r.eq("B: Enter closed the menu", await page.locator(MENU).count(), 0);
    r.eq("B: and left the block as it was", await blockTexts(page), [
      "alpha",
      URL,
    ]);

    // ---- C: the same URL on a NON-empty block does not open the menu ----------
    // A drop into existing text lands where the browser puts it, not at a caret
    // we hold — so the drop arm keeps its empty-block gate.
    await parkAwayFromDropTarget(page);
    await dropOn(page, 1, { "text/plain": URL });
    r.eq(
      "C: a non-empty block does not open the menu",
      await page.locator(MENU).count(),
      0,
    );
    r.eq("C: and nothing was inserted", await blockTexts(page), ["alpha", URL]);

    // ---- D: a text/uri-list-only transfer opens it too ------------------------
    // No `text/plain` at all: a bare `getData("text/plain")` reads "" here, which
    // is exactly what `readTransferText` exists to stop.
    // Near the RIGHT edge, past the text: block 1 now holds a link, and a plain
    // click on a link opens it (`ClickableLinkPlugin`) instead of placing the
    // caret.
    const linkBlock = editableBlocks(page).nth(1);
    const linkBox = await linkBlock.boundingBox();
    if (!linkBox) throw new Error("block 1 has no box");
    await linkBlock.click({
      position: { x: linkBox.width - 4, y: linkBox.height / 2 },
    });
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    r.eq("D: setup — a third, empty block", (await blockTexts(page)).length, 3);

    await parkAwayFromDropTarget(page);
    await dropOn(page, 2, { "text/uri-list": `${URI_LIST_URL}\r\n` });
    const uriListOpened = (await page.locator(MENU).count()) > 0;
    r.ok("D: a uri-list-only drop opened the menu", uriListOpened);
    if (!uriListOpened) await snap(page, OUT, "no-menu-uri-list");

    await page.keyboard.press("Enter"); // "Keep as link"
    await page.waitForTimeout(800);
    // The CRLF the uri-list carried must not survive into the block.
    r.eq("D: the trimmed URL landed in the block", await blockTexts(page), [
      "alpha",
      URL,
      URI_LIST_URL,
    ]);

    await snap(page, OUT, "final");
  } finally {
    await destroyScratchPage();
  }

  await r.finish();
});
