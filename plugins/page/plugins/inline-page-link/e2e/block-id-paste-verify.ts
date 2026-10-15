// End-to-end check that a pasted bare block id becomes a page reference.
// MANUAL ONLY — nothing runs this automatically.
//
// Verifies, each case in a block of its own:
//   A. an id pasted into an EMPTY block turns the block into a `page-link`
//      block pointing at that page
//   B. an id pasted after text becomes an inline chip showing the page's title,
//      the typed text kept beside it
//   C. Cmd+Z takes back only the pasted chip — the typed text survives
//
// The pastes are SYNTHETIC (a dispatched ClipboardEvent), the same path
// Lexical's PASTE_COMMAND reads — see url-paste's url-paste-link-verify.ts.
// The script creates its OWN scratch pages and deletes them on the way out.
//
// Usage:
//   ./singularity run plugins/page/plugins/inline-page-link/e2e/block-id-paste-verify.ts [--url <deploy>] [--headed]
import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out", "/tmp/block-id-paste-verify");
const UNDO = "ControlOrMeta+z";
const SCRATCH_TITLE = "zz block-id paste e2e";
const TARGET_TITLE = "zz block-id paste target";

const r = report();

interface Row {
  id: string;
  type: string;
  data: Record<string, unknown>;
  expanded: boolean;
}

function blockEl(page: Page, blockId: string): Locator {
  return page.locator(`[data-block-id="${blockId}"] [contenteditable="true"]`);
}

async function textOf(block: Locator): Promise<string> {
  // Whitespace-collapsed: the chip is a decorator element, and innerText may
  // break a line around it even though it renders inline.
  return (await block.innerText()).replace(/\s+/g, " ").trim();
}

async function focusEnd(page: Page, block: Locator): Promise<void> {
  const box = await block.boundingBox();
  if (!box) throw new Error("block has no box");
  await block.click({ position: { x: box.width - 4, y: box.height / 2 } });
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
}

async function pasteText(
  page: Page,
  block: Locator,
  text: string,
): Promise<void> {
  await block.evaluate((el: Element, t: string) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
  await page.waitForTimeout(600);
}

async function fetchRows(page: Page, pageId: string): Promise<Row[]> {
  return page.evaluate(async (id: string) => {
    const res = await fetch(`/api/pages/${id}/blocks`);
    if (!res.ok) throw new Error(`GET blocks failed: ${res.status}`);
    return (await res.json()) as Row[];
  }, pageId);
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);

  await boot(page, pathUrl("/pages"), {
    marker: "text=Pages",
    timeoutMs: 90_000,
  });

  const created = await page.evaluate(
    async ({ title, target }: { title: string; target: string }) => {
      const create = async (body: unknown): Promise<string> => {
        const res = await fetch("/api/blocks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok)
          throw new Error(`create failed: ${res.status} ${await res.text()}`);
        return ((await res.json()) as { id: string }).id;
      };
      const targetId = await create({
        parentId: null,
        type: "page",
        data: { title: target, icon: null },
      });
      const pageId = await create({
        parentId: null,
        type: "page",
        data: { title, icon: null },
      });
      const blockIds: string[] = [];
      for (let i = 0; i < 2; i++)
        blockIds.push(
          await create({ parentId: pageId, type: "text", data: { text: [] } }),
        );
      return { pageId, targetId, blockIds };
    },
    { title: SCRATCH_TITLE, target: TARGET_TITLE },
  );
  const { pageId, targetId } = created;
  const [aId, bId] = created.blockIds as [string, string];
  console.log(`scratch page: ${pageId}, target: ${targetId}`);

  try {
    await page.locator(`text=${SCRATCH_TITLE}`).last().click();
    await page.waitForURL(`**/pages/page/${pageId}`);
    await blockEl(page, bId).waitFor({ state: "visible" });

    // ---- A: empty block → page-link block ------------------------------------
    console.log("\n=== A: id into an empty block converts it");
    const a = blockEl(page, aId);
    await focusEnd(page, a);
    await pasteText(page, a, targetId);
    const converted = await waitFor(
      async () => (await fetchRows(page, pageId)).find((x) => x.id === aId),
      (row) => row?.type === "page-link",
      { timeoutMs: 10_000 },
    );
    r.eq("A: row type", converted.value?.type, "page-link");
    r.eq("A: points at the target", converted.value?.data.pageId, targetId);
    r.eq("A: collapsed", converted.value?.expanded, false);
    if (!converted.ok) await snap(page, OUT, "a-not-converted");

    // ---- B: inline chip -------------------------------------------------------
    console.log("\n=== B: id after text becomes an inline chip");
    const b = blockEl(page, bId);
    await focusEnd(page, b);
    await page.keyboard.type("see ");
    await pasteText(page, b, targetId);
    const chip = await waitFor(
      () => textOf(b),
      (t) => t.includes(TARGET_TITLE),
      { timeoutMs: 10_000 },
    );
    r.eq("B: text + chip title", chip.value, `see ${TARGET_TITLE}`);
    r.ok("B: no literal id left", !(await textOf(b)).includes(targetId));
    if (!chip.ok) await snap(page, OUT, "b-no-chip");
    await snap(page, OUT, "b-chip");

    // ---- C: Cmd+Z takes back only the paste -----------------------------------
    console.log("\n=== C: Cmd+Z removes only the chip");
    await page.keyboard.press(UNDO);
    await page.waitForTimeout(600);
    r.eq("C: typed text survives", await textOf(b), "see");

    await snap(page, OUT, "final");
  } finally {
    await page.evaluate(
      async (ids: string[]) => {
        for (const id of ids)
          await fetch(`/api/blocks/${id}`, { method: "DELETE" });
      },
      [pageId, targetId],
    );
    console.log("\nscratch pages deleted");
  }

  await r.finish();
});
