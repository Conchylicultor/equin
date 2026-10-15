// An agent card becomes an agent-authored page from its rail menu.
//
//  T1. The handle on the card's borrowed (first) line opens the CONTAINER's
//      menu, and that menu offers "Turn into" → "Agent page" — the one Turn into
//      a void container has, contributed `from: agent-note` by agent-page.
//  T2. Picking it turns the card into an agent-authored page IN PLACE: the same
//      block id, still under the page, `type: "page"`, `author: "agent"`, titled
//      with the card's first line.
//  T3. The first line is consumed (gone from the new page's content); the
//      second line is the page's content, re-scoped into it; the row renders in
//      the parent as a sub-page row titled with the first line.
//
// Manual only. Requires `./singularity build` first.
// Usage: ./singularity run plugins/page/plugins/annotations/plugins/agent-notes/plugins/agent-page/e2e/card-turn-into-agent-page-verify.ts \
//          [--out /tmp/card-agent-page]
import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage, pageIdFromUrl } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/card-agent-page");
const r = report("agent card → agent page");

const HANDLE = 'button[aria-label="Reorder or open block actions"]';
const TITLE_LINE = "Findings from the decoder";
const BODY_LINE = "the second line stays as content";

interface Row {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type: string;
  data: { title?: string; author?: string; text?: { text: string }[] };
}

/** The live rows of one page's content, as the server holds them. */
async function rowsOf(page: Page, pageId: string): Promise<Row[]> {
  return page.evaluate(async (id: string) => {
    const res = await fetch(`/api/pages/${id}/blocks`);
    if (!res.ok)
      throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
    return (await res.json()) as Row[];
  }, pageId);
}

const textOf = (row: Row): string =>
  (row.data.text ?? []).map((run) => run.text).join("");

/** Park the pointer over a row's text so its gutter controls are clickable. */
async function hoverText(page: Page, id: string): Promise<void> {
  const box = await page.evaluate((blockId) => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"]`,
    );
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width * 0.6, y: b.top + Math.min(12, b.height / 2) };
  }, id);
  if (!box) throw new Error(`row ${id} is not on screen`);
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(200);
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  const doc = await openBlankPage(page, { settleMs: 800 });
  const pageId = pageIdFromUrl(doc.pageUrl);

  const seeded = await page.evaluate(
    async ({ pageId, title, body }) => {
      const post = async (b: unknown) => {
        const res = await fetch("/api/blocks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(b),
        });
        if (!res.ok)
          throw new Error(
            `POST /api/blocks ${res.status}: ${await res.text()}`,
          );
        return (await res.json()) as { id: string };
      };
      const card = await post({
        parentId: pageId,
        type: "agent-note",
        data: {},
      });
      const text = (parentId: string, t: string) =>
        post({ parentId, type: "text", data: { text: [{ text: t }] } });
      const first = await text(card.id, title);
      const second = await text(card.id, body);
      return { card: card.id, first: first.id, second: second.id };
    },
    { pageId, title: TITLE_LINE, body: BODY_LINE },
  );
  console.log("seeded:", JSON.stringify(seeded));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(`[data-block-id="${seeded.second}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "1-card");

  // --- T1. the card's menu offers Turn into → Agent page ----------------------
  await hoverText(page, seeded.first);
  await page
    .locator(`[data-block-id="${seeded.first}"] ${HANDLE}`)
    .first()
    .click();
  await page.waitForTimeout(600);
  const popover = page.locator('[data-slot="popover-content"]');
  const turnInto = popover.getByText("Turn into", { exact: true }).first();
  const item = popover.getByText("Agent page", { exact: true }).first();
  r.ok(
    'T1: the card\'s rail menu has a "Turn into" section',
    await turnInto.isVisible(),
  );
  r.ok('T1: it offers "Agent page"', await item.isVisible());
  await snap(page, out, "2-menu");
  if (!(await item.isVisible())) return;

  await item.click();

  // --- T2. the card is the page, in place ------------------------------------
  let card: Row | undefined;
  for (let i = 0; i < 40; i++) {
    card = (await rowsOf(page, pageId)).find((b) => b.id === seeded.card);
    if (card?.type === "page") break;
    await page.waitForTimeout(250);
  }
  r.ok(
    "T2: the card row is now a page, same id, same parent",
    card?.type === "page" && card.parentId === pageId,
    JSON.stringify(card),
  );
  r.ok("T2: the page is agent-authored", card?.data.author === "agent");
  r.ok(
    "T2: the page is titled with the card's first line",
    card?.data.title === TITLE_LINE,
    `title: ${JSON.stringify(card?.data.title)}`,
  );

  // --- T3. first line consumed, second line is the content -------------------
  const content = await rowsOf(page, seeded.card);
  r.ok(
    "T3: the first line is gone from the page's content",
    !content.some((b) => b.id === seeded.first),
  );
  const second = content.find((b) => b.id === seeded.second);
  r.ok(
    "T3: the second line is the page's content, re-scoped into it",
    second !== undefined &&
      second.pageId === seeded.card &&
      second.parentId === seeded.card &&
      textOf(second) === BODY_LINE,
    JSON.stringify(content.map((b) => [b.id, b.parentId, textOf(b)])),
  );
  const pageRow = page.locator(`[data-block-id="${seeded.card}"]`).first();
  await pageRow
    .getByText(TITLE_LINE)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  r.ok(
    "T3: the parent renders a sub-page row titled with the first line",
    await pageRow.getByText(TITLE_LINE).first().isVisible(),
  );
  await snap(page, out, "3-page");
});

await r.finish();
