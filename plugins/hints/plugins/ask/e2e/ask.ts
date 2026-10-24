// The Ask equin card, end to end — WITHOUT asking anything (no agent is
// launched: no cost, nothing nondeterministic):
//
//   1. ? (through the folded action bar) → Ask equin how to… opens the empty
//      card in the bottom-right corner, its 3 suggestions led by the two fixed
//      newcomer questions
//   2. a real mouse drag of the header moves it freely: dropped mid-screen it
//      stays exactly where it was dropped
//   3. dropped near the top-left corner it snaps to the corner's inset
//   4. reload, reopen: the card opens where it was left
//   5. Close (×) closes it
//
//   ./equin run plugins/hints/plugins/ask/e2e/ask.ts [--out /tmp/ask] [--headed]

import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  DEFAULT_VIEWPORT,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openFloatingActionBar } from "@plugins/shell/plugins/global-action-bar/e2e";
import {
  ALWAYS_SUGGESTIONS,
  CORNER_MARGIN,
} from "@plugins/hints/plugins/ask/core";

const out = arg("out") ?? "/tmp/ask";
const r = report("hints/ask: the Ask equin card");

/** How far off a placement may land (sub-pixel rounding). */
const TOLERANCE = 2;

const card = (page: Page) => page.getByRole("dialog", { name: "Ask equin" });
/** The card's header row — the whole of it is the drag handle. */
const header = (c: Locator) => c.locator(".cursor-grab").first();

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("the card has no box");
  return b;
}

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

/**
 * Open the empty card from ? → Ask equin. A run this worktree asked earlier
 * may be taken back on load (the entry then reads "Back to your question"
 * and opens its thread): New question lets go of it for the empty card.
 */
async function openEmptyCard(page: Page): Promise<Locator> {
  await openFloatingActionBar(page);
  await page.getByRole("button", { name: "Getting started" }).click();
  await page
    .getByText(/^(Ask equin how to…|Back to your question)$/)
    .first()
    .click();
  const c = card(page);
  await c.waitFor();
  const fresh = c.getByRole("button", { name: "New question", exact: true });
  if (await fresh.isVisible()) {
    r.note("a previous run was restored — New question for the empty card");
    await fresh.click();
  }
  await c.getByRole("button", { name: "Close", exact: true }).waitFor();
  // Let the pointer leave the bar so it folds away from the card.
  await page.mouse.move(DEFAULT_VIEWPORT.width / 2, 300);
  return c;
}

/** Press the header at its title, move in steps, release at `to` + offset. */
async function dragHeader(
  page: Page,
  c: Locator,
  dx: number,
  dy: number,
): Promise<void> {
  const h = await box(header(c));
  // Left part of the header: the title, not an action button.
  const x = h.x + 60;
  const y = h.y + h.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  await boot(page, pathUrl("/home"), { marker: "[data-health]" });
  const vw = DEFAULT_VIEWPORT.width;
  const vh = DEFAULT_VIEWPORT.height;

  // 1. open, bottom-right, suggestions
  const c = await openEmptyCard(page);
  await snap(page, out, "1-open");
  const b0 = await box(c);
  r.ok(
    "the card opens in the bottom-right corner (16px inset)",
    near(vw - (b0.x + b0.width), CORNER_MARGIN) &&
      near(vh - (b0.y + b0.height), CORNER_MARGIN),
    `box ${JSON.stringify(b0)} in ${vw}x${vh}`,
  );
  // The suggestion rows: the card's buttons that read as a question.
  const texts = (
    await c
      .locator("button")
      .filter({ hasText: /\?\s*$/ })
      .allInnerTexts()
  ).map((t) => t.trim());
  r.eq("3 suggested questions", texts.length, 3);
  r.eq("…led by the two fixed newcomer questions", texts.slice(0, 2), [
    ...ALWAYS_SUGGESTIONS,
  ]);

  // 2. free drag, mid-screen
  await dragHeader(page, c, -420, -260);
  const b1 = await box(c);
  r.ok(
    "dragged mid-screen, the card stays where it was dropped",
    near(b1.x, b0.x - 420) && near(b1.y, b0.y - 260),
    `expected (${b0.x - 420}, ${b0.y - 260}), got (${b1.x}, ${b1.y})`,
  );
  await page.waitForTimeout(300);
  const b1b = await box(c);
  r.ok(
    "…and is still there after it settles",
    near(b1b.x, b1.x) && near(b1b.y, b1.y),
    `(${b1.x}, ${b1.y}) → (${b1b.x}, ${b1b.y})`,
  );
  await snap(page, out, "2-dragged");

  // 3. near the top-left corner → snaps to the inset
  await dragHeader(
    page,
    c,
    CORNER_MARGIN + 14 - b1b.x,
    CORNER_MARGIN + 12 - b1b.y,
  );
  const b2 = await box(c);
  r.ok(
    "dropped ~20px from the top-left corner, it snaps to the 16px inset",
    near(b2.x, CORNER_MARGIN) && near(b2.y, CORNER_MARGIN),
    `got (${b2.x}, ${b2.y})`,
  );
  await snap(page, out, "3-snapped");

  // 4. reload → reopen where it was left
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-health]").first().waitFor();
  const c2 = await openEmptyCard(page);
  const b3 = await box(c2);
  r.ok(
    "after a reload the card reopens where it was left (top-left)",
    near(b3.x, CORNER_MARGIN) && near(b3.y, CORNER_MARGIN),
    `got (${b3.x}, ${b3.y})`,
  );
  await snap(page, out, "4-reloaded");

  // 5. Close
  await c2.getByRole("button", { name: "Close", exact: true }).click();
  await c2.waitFor({ state: "detached" });
  r.ok("Close (×) closes the card", (await card(page).count()) === 0);

  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
});

await r.finish();
