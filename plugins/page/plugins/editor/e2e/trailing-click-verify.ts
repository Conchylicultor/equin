// Clicking the empty space below a page — Notion's click-below-the-document.
//
// The space below a short page is NOT the block list's own pointer surface (its
// trailing zone is a thin padding strip); it is the page host's filler, which
// asks the editor to `focusEnd()`. Asserted, from the very bottom of the pane:
//
//  1. last block has text → a fresh empty block is appended and holds the caret;
//  2. last block is already empty → no second blank block, the caret goes there.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/trailing-click-verify.ts \
//          [--out /tmp/trailing-click]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/trailing-click");
const r = report("trailing-click");

/** A click near the bottom of the viewport, well below a short page's last block. */
async function clickPageBottom(page: Page): Promise<void> {
  const vp = page.viewportSize();
  if (!vp) throw new Error("no viewport size");
  await page.mouse.click(vp.width / 2, vp.height - 40);
  await page.waitForTimeout(900);
}

async function focusedBlockId(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.activeElement
        ?.closest("[data-block-id]")
        ?.getAttribute("data-block-id") ?? null,
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "trailing-click" });
  await openBlankPage(page, { settleMs: 2500, timeoutMs: 60_000 });
  await page.keyboard.type("Play not soft enough", { delay: 20 });
  await page.waitForTimeout(600);
  await snap(page, out, "1-one-block");

  const blocks = editableBlocks(page);
  r.ok("starts with one block", (await blocks.count()) === 1);

  await clickPageBottom(page);
  await snap(page, out, "2-appended");
  r.ok(
    "click below a non-empty last block appends one",
    (await blocks.count()) === 2,
    `count=${await blocks.count()}`,
  );
  const lastId = await blockIdOf(blocks.last());
  r.ok(
    "…and the caret is in the new last block",
    (await focusedBlockId(page)) === lastId,
  );

  // Move the caret away, then click below again: the empty last block is reused.
  await blocks.first().click();
  await page.waitForTimeout(400);
  await clickPageBottom(page);
  await snap(page, out, "3-reused");
  r.ok(
    "click below an empty last block adds nothing",
    (await blocks.count()) === 2,
    `count=${await blocks.count()}`,
  );
  r.ok(
    "…and puts the caret in that empty block",
    (await focusedBlockId(page)) === lastId,
  );

  await r.finish();
});
