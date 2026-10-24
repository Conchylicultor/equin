// Dragging a block SELECTION into an expanded sub-page, in a real browser.
//
// The defect: the drop was dispatched as a `bulkMove` op on the SOURCE page,
// whose endpoint refuses a destination outside that page with a 400. The
// optimistic overlay kept rendering the move, the sync cloud read "Could not
// save", the stuck op kept re-opening the sub-page (so its chevron could not
// collapse it), and a reload put every block back. A cross-page selection drop
// now goes to `POST /api/blocks/move-many`, which moves the set across the
// page boundary in one transaction.
//
// Phases:
//   A. select two top-level lines, drag them onto a line inside an expanded
//      sub-page: ONE move-many POST, NO op POST, and the rows now belong to the
//      sub-page in server truth (and no longer to the parent page)
//   B. the sub-page's chevron collapses it afterwards (server `expanded` false,
//      its content off screen)
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/cross-page-selection-drop-verify.ts
import {
  agentFetch,
  report,
  stallRoute,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";
import { blockSelectionDriver } from "./support/block-selection";
import { typeLines } from "./support/type-lines";

interface Row {
  id: string;
  type: string;
  parentId: string | null;
  expanded: boolean;
  data?: { title?: string; text?: { text: string }[] } | null;
}

async function rowsOf(pageId: string): Promise<Row[]> {
  const res = await agentFetch(`/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`blocks fetch ${pageId}: ${res.status}`);
  return (await res.json()) as Row[];
}

const textsOf = (rows: Row[]): string[] =>
  rows
    .flatMap((row) => row.data?.text ?? [])
    .map((run) => run.text)
    .filter((text) => text.length > 0)
    .sort();

const r = report();

await withBrowser(async (h) => {
  const { page } = await h.session();
  const { enterBlockSelection, selectedCount } = blockSelectionDriver(page, r);

  // ---- Setup: alpha / bravo / a sub-page holding "inside", expanded ----------
  const parent = await openBlankPage(page, { settleMs: 3000 });
  await typeLines(page, ["alpha", "bravo", "Sub"]);
  await page.waitForTimeout(2500);
  const subId = await blockIdOf(editableBlocks(page).nth(2));

  const turned = await agentFetch(`/api/blocks/${subId}/turn-into-page`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Sub", seedChild: { type: "text" } }),
  });
  r.eq("setup: turned the line into a sub-page", turned.ok, true);
  const [seed] = (await rowsOf(subId)).filter((row) => row.type === "text");
  const wrote = await agentFetch(`/api/pages/${subId}/blocks/op`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "insert",
      newId: `block-${crypto.randomUUID()}`,
      type: "text",
      data: { text: [{ text: "inside" }] },
      afterId: seed?.id ?? null,
      parentId: subId,
    }),
  });
  r.eq("setup: wrote content into the sub-page", wrote.ok, true);
  const expanded = await agentFetch(`/api/blocks/${subId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expanded: true }),
  });
  r.eq("setup: expanded the sub-page inline", expanded.ok, true);

  await page.reload({ waitUntil: "domcontentloaded" });
  const insideRow = page
    .locator("[data-block-id]")
    .filter({ hasText: "inside" })
    .last();
  await insideRow.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);

  // ---- A: drag the selection into the sub-page --------------------------------
  await enterBlockSelection("A", 0, "Shift+ArrowDown");
  r.eq(
    "A: the gesture starts from a two-block selection",
    await selectedCount(),
    2,
  );

  const ops = await stallRoute(page, "**/api/pages/*/blocks/op", {
    ms: 0,
    times: 0,
  });
  const moves = await stallRoute(page, "**/api/blocks/move-many", {
    ms: 0,
    times: 0,
  });

  const srcRow = page
    .locator("[data-block-id]")
    .filter({ hasText: "alpha" })
    .last();
  const src = await srcRow.boundingBox();
  if (!src) throw new Error("alpha row has no box");
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.waitForTimeout(200);
  const handle = srcRow.getByLabel("Reorder or open block actions");
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("alpha row has no drag handle");
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 8, {
    steps: 3,
  });
  const dst = await insideRow.boundingBox();
  if (!dst) throw new Error("inside row has no box");
  await page.mouse.move(hb.x + hb.width / 2, dst.y + dst.height * 0.75, {
    steps: 12,
  });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(3000);

  r.eq("A: the drop sent no op to the source page", ops.count, 0);
  r.eq("A: the drop was ONE move-many POST", moves.count, 1);
  r.eq(
    "A: the sub-page now holds the dragged lines (server truth)",
    textsOf(await rowsOf(subId)),
    ["alpha", "bravo", "inside"],
  );
  r.eq(
    "A: ... and the parent page no longer does",
    textsOf(await rowsOf(parent.pageId)),
    [],
  );
  // The machine-readable sync phase, not the tooltip copy (which never
  // matched "Could not save"), plus the rejection toast a 4xx would raise.
  const syncError = await page.locator('[data-sync-phase="error"]').count();
  r.eq("A: the sync cloud is not in error", syncError, 0);
  const rejectionToast = await page
    .getByText("Couldn't save page edit")
    .count();
  r.eq("A: no rejection toast", rejectionToast, 0);

  // ---- B: the chevron collapses the sub-page ----------------------------------
  const chevron = page.locator(`[data-chevron-for="${subId}"]`).first();
  const subRow = page.locator(`[data-block-id="${subId}"]`).first();
  await subRow.hover();
  await page.waitForTimeout(200);
  await chevron.click();
  await page.waitForTimeout(2500);
  const insideCount = () =>
    page.locator("[data-block-id]").filter({ hasText: "inside" }).count();
  r.eq("B: its content is off screen", await insideCount(), 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await subRow.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);
  r.eq(
    "B: ... and stays collapsed after a reload (server truth)",
    await insideCount(),
    0,
  );

  await r.finish();
});
