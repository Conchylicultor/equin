// A page edit the server PERMANENTLY rejects (a 4xx), in a real browser.
//
// The defect: a rejected op stayed in the optimistic overlay forever — the page
// kept showing an edit the server never held, every later op on the same block
// parked behind it, the only signal was the sync cloud's tooltip, and a reload
// silently threw the edit away. A permanent rejection now drops the op (the page
// renders server truth), toasts the user, files a report, and un-records the
// undo step.
//
// Phases (the op endpoint is forced to answer 400 ONCE, for a Tab-indent):
//   A. the toast tells the user the edit was not saved; the cloud is NOT stuck
//      in `error`; the line is back at top level (server truth: never indented)
//   B. the SAME indent, re-issued with the route released, saves — nothing is
//      parked behind the rejected op
//   C. one Cmd+Z undoes B's indent; a second undoes nothing the server never
//      held (the rejected step was dropped from the stack)
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/rejected-op-verify.ts
import {
  agentFetch,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

interface Row {
  id: string;
  parentId: string | null;
}

async function parentOf(
  pageId: string,
  blockId: string,
): Promise<string | null> {
  const res = await agentFetch(`/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`blocks fetch ${pageId}: ${res.status}`);
  const row = ((await res.json()) as Row[]).find((b) => b.id === blockId);
  if (!row) throw new Error(`block ${blockId} is not on page ${pageId}`);
  return row.parentId;
}

const r = report();
const REJECTION = "forced rejection (rejected-op-verify)";

await withBrowser(async (h) => {
  const { page } = await h.session();

  // ---- Setup: alpha / bravo, caret at the end of bravo --------------------------
  const doc = await openBlankPage(page, { settleMs: 3000 });
  await typeLines(page, ["alpha", "bravo"]);
  await page.waitForTimeout(2500);
  const alphaId = await blockIdOf(editableBlocks(page).nth(0));
  const bravoId = await blockIdOf(editableBlocks(page).nth(1));
  const indentOf = (id: string) =>
    page
      .locator(`[data-block-id="${id}"]`)
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  const topLevelLeft = await indentOf(bravoId);

  // ---- A: the indent is rejected ------------------------------------------------
  let rejected = 0;
  await page.route(
    "**/api/pages/*/blocks/op",
    async (route) => {
      rejected++;
      await route.fulfill({ status: 400, body: REJECTION });
    },
    { times: 1 },
  );
  await page.keyboard.press("Tab");
  const toast = page.getByText("Couldn't save page edit");
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  r.eq("A: the op endpoint answered the forced 400", rejected, 1);
  r.eq(
    "A: the toast carries the server's reason",
    (await page.getByText(REJECTION).count()) > 0,
    true,
  );
  await page.waitForTimeout(1000);
  r.eq(
    "A: the sync cloud is not stuck in error",
    await page.locator('[data-sync-phase="error"]').count(),
    0,
  );
  r.eq(
    "A: bravo renders back at top level (the rejected prediction left)",
    await indentOf(bravoId),
    topLevelLeft,
  );
  r.eq(
    "A: ... which is server truth",
    await parentOf(doc.pageId, bravoId),
    doc.pageId, // a top-level line's parent is the page row
  );

  // ---- B: the same indent saves once the route is released ----------------------
  await editableBlocks(page).nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2500);
  r.eq(
    "B: the re-issued indent saved (nothing parked behind the rejection)",
    await parentOf(doc.pageId, bravoId),
    alphaId,
  );
  r.eq(
    "B: ... and renders indented",
    (await indentOf(bravoId)) > topLevelLeft,
    true,
  );

  // ---- C: undo skips the rejected step -------------------------------------------
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(2500);
  r.eq(
    "C: one undo outdents bravo (B's step)",
    await parentOf(doc.pageId, bravoId),
    doc.pageId, // a top-level line's parent is the page row
  );
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(2500);
  r.eq(
    "C: a second undo never replays the rejected indent's inverse",
    (await page.getByText("Couldn't save page edit").count()) <= 1,
    true,
  );
  r.eq(
    "C: bravo is still a top-level line",
    await parentOf(doc.pageId, bravoId),
    doc.pageId, // a top-level line's parent is the page row
  );

  await r.finish();
});
