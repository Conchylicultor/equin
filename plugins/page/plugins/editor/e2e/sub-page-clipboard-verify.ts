// Cut / paste of a SUB-PAGE, in a real browser.
//
// The defect: a sub-page's content lives in its own page partition, which the
// editor on screen never loads, so a copied sub-page carried only its title —
// cut + paste produced an EMPTY page and sent the original, content and all, to
// the trash. Now a page node carries its `pageSource` and:
//   A. cut, then paste on another page MOVES the page: same id (its URL and
//      links still work), content intact, gone from the source page;
//   B. pasting the same clipboard again makes a COPY: a new id, content cloned.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/sub-page-clipboard-verify.ts
import {
  agentFetch,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";
import { blockSelectionDriver } from "./support/block-selection";
import { typeLines } from "./support/type-lines";

interface Row {
  id: string;
  type: string;
  parentId: string | null;
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
    .filter((text) => text.length > 0);

const r = report();

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { checkSelectionOwnsFocus, enterBlockSelection } = blockSelectionDriver(
    page,
    r,
  );

  // ---- Setup: page 1 holds "alpha" and a sub-page with a line of content ------
  const first = await openBlankPage(page, { settleMs: 3000 });
  await typeLines(page, ["alpha", "Moved page"]);
  await page.waitForTimeout(2500);
  const subId = await blockIdOf(editableBlocks(page).nth(1));

  const turned = await agentFetch(`/api/blocks/${subId}/turn-into-page`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Moved page", seedChild: { type: "text" } }),
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
      data: { text: [{ text: "content that must survive" }] },
      afterId: seed?.id ?? null,
      parentId: subId,
    }),
  });
  r.eq("setup: wrote content into the sub-page", wrote.ok, true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await editableBlocks(page).first().waitFor({ state: "visible" });
  await page.waitForTimeout(3000);

  // ---- A: cut both lines, paste on page 2 → the page MOVES -------------------
  // The sub-page row owns no text, so select from "alpha" and extend onto it.
  await enterBlockSelection("A", 0, "Shift+ArrowDown");
  await checkSelectionOwnsFocus("A (cut)");
  await page.keyboard.press("Meta+x");
  await page.waitForTimeout(2500);
  r.eq(
    "A: the sub-page left page 1",
    (await rowsOf(first.pageId)).some((row) => row.id === subId),
    false,
  );

  const second = await openBlankPage(page, { settleMs: 3000 });
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(3000);

  const afterMove = await rowsOf(second.pageId);
  r.eq(
    "A: page 2 holds the SAME sub-page (same id)",
    afterMove.some((row) => row.id === subId && row.type === "page"),
    true,
  );
  r.eq(
    "A: its content came with it",
    textsOf(await rowsOf(subId)).includes("content that must survive"),
    true,
  );

  // ---- B: paste the same clipboard again → a COPY with the content -----------
  await editableBlocks(page).first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(3000);

  const copies = (await rowsOf(second.pageId)).filter(
    (row) => row.type === "page" && row.id !== subId,
  );
  r.eq("B: a second paste made exactly one new page", copies.length, 1);
  const copyId = copies[0]?.id;
  r.eq(
    "B: the copy carries the content",
    copyId
      ? textsOf(await rowsOf(copyId)).includes("content that must survive")
      : false,
    true,
  );
  r.eq(
    "B: the original still holds its content",
    textsOf(await rowsOf(subId)).includes("content that must survive"),
    true,
  );

  await r.finish();
});
