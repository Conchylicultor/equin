/**
 * Verifies a queue reorder end to end over the optimistic `queueRanks` id-set
 * read: dragging a queued row below another moves it AT ONCE (the overlay),
 * the reorder endpoint answers 2xx, the new order HOLDS once the server's delta
 * lands (confirmation, not a snap-back), the sync-status cloud never shows an
 * error, and a reload paints the same order (server truth). Then drags the row
 * back, so the worktree's queue ends as it started.
 *
 *   ./equin run plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/e2e/queue-reorder.ts [--out <prefix>] [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/queue-reorder";
const ITEMS = '[data-ui-owner^="ConversationItem"]';

interface RowBox {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The first `n` queue rows, in DOM order (the queue section leads): one entry
 * per list Row, however many elements inside it are owned by ConversationItem.
 */
async function rowBoxes(page: Page, n: number): Promise<RowBox[]> {
  return page.locator(ITEMS).evaluateAll((els, count) => {
    const rows: HTMLElement[] = [];
    for (const el of els) {
      const row = (el as HTMLElement).closest(
        '[data-ui-owner^="Row@"]',
      ) as HTMLElement | null;
      if (row && !rows.includes(row)) rows.push(row);
    }
    return rows.slice(0, count).map((row) => {
      const b = row.getBoundingClientRect();
      return {
        title: row.innerText.split("\n")[0] ?? "",
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
      };
    });
  }, n);
}

async function titles(page: Page, n: number): Promise<string[]> {
  return (await rowBoxes(page, n)).map((b) => b.title);
}

/** The drop indicator a row's before/after zone paints while hovered. */
const INDICATOR = ".bg-primary.h-\\[2px\\].rounded-full";

/**
 * Drag row `from` to the `edge` of row `to`: past the 4 px activation in small
 * steps, then sweep across that edge until the drop indicator shows, and drop.
 */
async function drag(
  page: Page,
  from: number,
  to: number,
  edge: "top" | "bottom",
): Promise<boolean> {
  const boxes = await rowBoxes(page, Math.max(from, to) + 1);
  const src = boxes[from];
  const dst = boxes[to];
  if (!src || !dst) throw new Error("a row has no box");
  const x = src.x + src.width / 2;
  const startY = src.y + src.height / 2;
  const edgeY = edge === "bottom" ? dst.y + dst.height : dst.y;
  await page.mouse.move(x, startY);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(x, startY + ((edgeY - 8 - startY) * i) / 20);
    await page.waitForTimeout(20);
  }
  let shown = false;
  for (let y = edgeY - 8; y <= edgeY + 8 && !shown; y += 1) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(30);
    shown = (await page.locator(INDICATOR).count()) > 0;
  }
  await snap(page, OUT, `mid-drag-${from}-${to}`);
  await page.mouse.up();
  return shown;
}

await withBrowser(async (h) => {
  const r = report("conversations queue — drag reorder over queueRanks");
  const { page, captured } = await h.session();

  const reorders: number[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/conversations-queue/reorder"))
      reorders.push(res.status());
  });
  const syncErrors: string[] = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (/stalled|diverg|optimistic/i.test(t)) syncErrors.push(t);
  });

  await page.goto(pathUrl("agents"), { waitUntil: "domcontentloaded" });
  await page
    .locator(ITEMS)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);

  r.note(`boxes: ${JSON.stringify(await rowBoxes(page, 4))}`);
  const before = await titles(page, 4);
  r.note(`before: ${JSON.stringify(before)}`);
  if (new Set(before).size !== before.length)
    throw new Error(
      "the first four rows share a title — cannot tell them apart",
    );
  const moved = before[0]!;
  const want = [before[1], before[2], moved, before[3]];

  r.ok(
    "the drop indicator shows below row 3",
    await drag(page, 0, 2, "bottom"),
  );
  const optimistic = await waitFor(
    () => titles(page, 4),
    (t) => JSON.stringify(t) === JSON.stringify(want),
    { timeoutMs: 3000 },
  );
  r.ok(
    "the drop reorders the row at once",
    optimistic.ok,
    JSON.stringify(optimistic.value),
  );
  await snap(page, OUT, "dropped");

  const answered = await waitFor(
    async () => reorders.length,
    (n) => n > 0,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "the reorder endpoint answered 2xx",
    answered.ok && reorders.every((s) => s >= 200 && s < 300),
    JSON.stringify(reorders),
  );

  // Hold: the server's delta lands and replaces the overlay — no snap-back.
  await page.waitForTimeout(3000);
  r.eq("the order holds once the server confirms", await titles(page, 4), want);
  r.eq(
    "the sync-status cloud shows no error",
    await page.getByText(/couldn.t save|not saved|failed to save/i).count(),
    0,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(ITEMS)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  const reloaded = await waitFor(
    () => titles(page, 4),
    (t) => JSON.stringify(t) === JSON.stringify(want),
    { timeoutMs: 10_000 },
  );
  r.ok(
    "a reload paints the same order (server truth)",
    reloaded.ok,
    JSON.stringify(reloaded.value),
  );

  // Put it back: the moved row (now index 2) above the first row.
  r.ok("the drop indicator shows above row 1", await drag(page, 2, 0, "top"));
  const restored = await waitFor(
    () => titles(page, 4),
    (t) => JSON.stringify(t) === JSON.stringify(before),
    { timeoutMs: 10_000 },
  );
  r.ok(
    "dragging it back restores the original order",
    restored.ok,
    JSON.stringify(restored.value),
  );
  await page.waitForTimeout(3000);
  r.eq("…and that order holds too", await titles(page, 4), before);

  r.eq("no optimistic stall/divergence in the console", syncErrors, []);
  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
