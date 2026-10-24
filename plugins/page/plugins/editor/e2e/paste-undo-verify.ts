// Cmd+Z right after a caret paste takes the paste back.
//
// Each phase writes the system clipboard, pastes with a real Meta+V into a
// block, presses Cmd+Z with NO settle (the user's gesture) and reads the DOM.
//
// Manual-only; nothing runs this automatically.
// Usage: ./equin run plugins/page/plugins/editor/e2e/paste-undo-verify.ts
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockTexts, openBlankPage } from "./support/blank-page";

const r = report();

async function writeClipboard(
  page: Page,
  plain: string,
  html?: string,
): Promise<void> {
  await page.evaluate(
    async ({ plain, html }) => {
      const items: Record<string, Blob> = {
        "text/plain": new Blob([plain], { type: "text/plain" }),
      };
      if (html) items["text/html"] = new Blob([html], { type: "text/html" });
      await navigator.clipboard.write([new ClipboardItem(items)]);
    },
    { plain, html },
  );
}

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openBlankPage(page, { settleMs: 3000 });

  // ---- A: paste into an EMPTY block, undo at once ---------------------------
  await writeClipboard(page, "pasted");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(100);
  r.eq("A: pasted", (await blockTexts(page))[0], "pasted");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(800);
  r.eq("A: Cmd+Z empties the block", (await blockTexts(page))[0], "");

  // ---- B: paste after typed text (typed run still open), undo ---------------
  await page.keyboard.type("hello ");
  await page.waitForTimeout(1000); // typing run closes
  await writeClipboard(page, "world");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(100);
  r.eq("B: pasted", (await blockTexts(page))[0], "hello world");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(800);
  r.eq("B: Cmd+Z removes only the paste", (await blockTexts(page))[0], "hello");

  // ---- C: html paste, undo after the run window -----------------------------
  await page.keyboard.press("End");
  await writeClipboard(page, "bold", "<b>bold</b>");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(1000);
  r.eq("C: pasted", (await blockTexts(page))[0], "hello bold");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(800);
  r.eq("C: Cmd+Z removes the html paste", (await blockTexts(page))[0], "hello");

  // ---- D: multi-line paste (splice op), undo --------------------------------
  await page.keyboard.press("End");
  await writeClipboard(page, "one\ntwo");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(1500);
  r.eq("D: pasted", (await blockTexts(page)).slice(0, 2), ["hello one", "two"]);
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(1500);
  r.eq("D: Cmd+Z takes the splice back", (await blockTexts(page))[0], "hello");

  await r.finish();
});
