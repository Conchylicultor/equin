// A concurrent structural write cannot reassert a column it never reasoned
// about — read off the AUTHORITATIVE rows, in a real browser.
// See research/2026-08-01-page-structural-write-contract.md (invariant A).
//
// **This is the captured incident.** `handleApplyBlockOp` read the forest
// OUTSIDE its write transaction, so two concurrent ops on one page both read the
// pre-state, and the later writer's UPDATE reasserted its stale snapshot over
// EVERY column — including ones its own op never touched:
//
//   indent  BEFORE[aaa<-page  bbb<-page]  AFTER[aaa<-page  bbb<-aaa ]
//   split   BEFORE[aaa<-page  bbb<-page]  <- read AFTER the indent committed
//           AFTER[aaa<-page  bbb<-page  ccc<-page]
//
// The split only meant to truncate `bbb`'s text; its row UPDATE carried
// `parentId` from a pre-indent read and silently UN-INDENTED the block. Invisible
// to the client, which had predicted both ops correctly — the next authoritative
// push simply superseded the indent.
//
// So: Tab then Enter with ZERO delay, and assert the indent survives in server
// truth for the block that was indented, BY ID. Only `withPageForest`'s lock
// makes the split's read happen after the indent's commit.
//
// Usage: bun plugins/page/plugins/editor/e2e/structural-atomicity-verify.ts [--url <deploy>]
import {
  pageFetch,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";

const r = report();

/** How many times the zero-delay Tab+Enter burst runs. A lost update is a RACE. */
const ROUNDS = 6;
/** Time allowed for both writes of a round to commit before rows are read. */
const COMMIT_MS = 3000;

interface Row {
  id: string;
  parentId: string | null;
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  /** The page's rows as the SERVER holds them — never a client cache. */
  const authoritativeRows = async (id: string): Promise<Row[]> => {
    const res = await pageFetch(page, `/api/pages/${id}/blocks`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`GET blocks -> ${res.status}`);
      const rows = (await res.json()) as {
        id: string;
        parentId: string | null;
      }[];
      return rows.map((b) => ({ id: b.id, parentId: b.parentId }));
  };

  /** The `data-block-id` of the row the caret is currently in. */
  const focusedBlockId = (): Promise<string | null> =>
    page.evaluate(() => {
      const node = window.getSelection()?.anchorNode ?? null;
      const el = node instanceof Element ? node : node?.parentElement;
      return (
        el?.closest("[data-block-id]")?.getAttribute("data-block-id") ?? null
      );
    });

  const { pageId } = await openBlankPage(page, { settleMs: 3000 });

  // A stable top-level parent for every round to indent under.
  await page.keyboard.type("head");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);

  const indentedIds: string[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    await page.keyboard.type(`kid-${round}`);
    await page.waitForTimeout(500); // let the text land; the RACE is the next two lines

    const target = await focusedBlockId();
    r.ok(`round ${round}: read the block id being indented`, target !== null);
    if (target === null) break;

    // Tab nests this block under its previous sibling; Enter immediately splits
    // it, and the split's row UPDATE restates `parentId`. Zero delay: an unlocked
    // read taken before the indent committed silently undoes it.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(COMMIT_MS);

    const rows = await authoritativeRows(pageId);
    const row = rows.find((b) => b.id === target);
    // THE assertion: the indented block is still nested in SERVER truth. Nested
    // means "parented to another content block" — a top-level row's parent is
    // the page itself.
    r.ok(
      `round ${round}: the indented block is still nested on the SERVER`,
      row !== undefined && row.parentId !== null && row.parentId !== pageId,
      `parentId=${row?.parentId ?? "<missing>"} pageId=${pageId}`,
    );
    indentedIds.push(target);

    // The split's tail inherited the indent; outdent it so the next round starts
    // from a top-level block again (and so `head` stays the parent).
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(1500);
  }

  // Server truth is what survives a reload — an op still pending in the overlay
  // keeps rendering its prediction under the never-revert policy, so the DOM
  // alone can never settle this.
  await page.reload({ waitUntil: "domcontentloaded" });
  await editableBlocks(page)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);

  const finalRows = await authoritativeRows(pageId);
  const byId = new Map(finalRows.map((b) => [b.id, b]));
  const stillNested = indentedIds.filter((id) => {
    const row = byId.get(id);
    return (
      row !== undefined && row.parentId !== null && row.parentId !== pageId
    );
  });
  r.eq(
    "every indent survives a reload",
    stillNested.length,
    indentedIds.length,
  );

  await r.finish();
});
