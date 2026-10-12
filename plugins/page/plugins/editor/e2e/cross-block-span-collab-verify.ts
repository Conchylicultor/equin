// A cross-block span delete, seen from a SECOND client on the same page.
//
// `deleteSpan` is one op and one server transaction precisely so another
// client never observes a half-applied edit (A truncated with C still there, or
// the middle line gone with A whole). This drives two independent browser
// contexts on one page: client A types three lines, drags a span from mid-line-1
// to mid-line-3 and presses Delete; client B must converge to the ONE joined
// line — rows (the lines between, the end line) and the start line's text (its
// content doc) alike — and back to the three lines on A's Cmd+Z. The states B
// renders on the way are printed (see the note at the assertion).
//
// Usage: ./singularity run plugins/page/plugins/editor/e2e/cross-block-span-collab-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import {
  blockTexts,
  editableBlocks,
  openBlankPage,
} from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const LINES = ["alpha one two", "bravo three four", "charlie five six"];
const FROM = 6;
const TO = 8;
const JOINED = LINES[0]!.slice(0, FROM) + LINES[2]!.slice(TO);

const r = report();

/** The viewport point just inside character `index` of block `blockIndex`. */
async function pointAt(
  page: Page,
  blockIndex: number,
  index: number,
): Promise<{ x: number; y: number }> {
  const box = await editableBlocks(page)
    .nth(blockIndex)
    .evaluate((el, i) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      if (!text) throw new Error("block has no text node");
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    }, index);
  return { x: box.x + 1, y: box.y };
}

/**
 * Every distinct block-text state client B renders from now on, recorded by a
 * MutationObserver inside the page — so a transient intermediate state (the
 * one thing an atomic op must never show) is caught even between two reads.
 */
async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const read = () =>
      JSON.stringify(
        [
          ...document.querySelectorAll(
            '[data-block-id] [contenteditable="true"]',
          ),
        ].map((el) => (el.textContent ?? "").trim()),
      );
    const seen: string[] = [read()];
    (window as unknown as { __states: string[] }).__states = seen;
    new MutationObserver(() => {
      const now = read();
      if (seen.at(-1) !== now) seen.push(now);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

function recordedStates(page: Page): Promise<string[][]> {
  return page.evaluate(() =>
    (window as unknown as { __states: string[] }).__states.map(
      (s) => JSON.parse(s) as string[],
    ),
  );
}

await withBrowser(async (h) => {
  const a = await h.session({ label: "A" });
  const b = await h.session({ label: "B" });

  const doc = await openBlankPage(a.page, { settleMs: 3000 });
  await typeLines(a.page, LINES);
  await a.page.waitForTimeout(2000);
  r.eq("setup: A has three lines", await blockTexts(a.page), LINES);

  await b.page.goto(doc.pageUrl, { waitUntil: "domcontentloaded" });
  await editableBlocks(b.page).first().waitFor({ state: "visible" });
  await b.page.waitForFunction(
    (expected) =>
      JSON.stringify(
        [
          ...document.querySelectorAll(
            '[data-block-id] [contenteditable="true"]',
          ),
        ].map((el) => (el.textContent ?? "").trim()),
      ) === expected,
    JSON.stringify(LINES),
    { timeout: 30_000 },
  );
  r.eq("setup: B sees the same three lines", await blockTexts(b.page), LINES);
  await recordStates(b.page);

  // A: the span, then Delete.
  const from = await pointAt(a.page, 0, FROM);
  const to = await pointAt(a.page, 2, TO);
  await a.page.mouse.move(from.x, from.y);
  await a.page.mouse.down();
  await a.page.waitForTimeout(600);
  await a.page.mouse.move(from.x + 4, from.y, { steps: 3 });
  await a.page.mouse.move(to.x, to.y, { steps: 15 });
  await a.page.mouse.up();
  await a.page.waitForTimeout(400);
  await a.page.keyboard.press("Delete");
  r.eq("A: Delete joins head1 + tail3", await blockTexts(a.page), [JOINED]);

  // B converges.
  const converged = await b.page
    .waitForFunction(
      (expected) =>
        JSON.stringify(
          [
            ...document.querySelectorAll(
              '[data-block-id] [contenteditable="true"]',
            ),
          ].map((el) => (el.textContent ?? "").trim()),
        ) === expected,
      JSON.stringify([JOINED]),
      { timeout: 15_000 },
    )
    .then(
      () => true,
      (err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return false;
        throw err;
      },
    );
  r.ok("B converges to the joined line", converged);
  r.eq("B: final text", await blockTexts(b.page), [JOINED]);
  await b.page.waitForTimeout(1500);

  // What B rendered on the way, for the record. Not asserted: the op is ONE
  // transaction, but a page's ROWS and a block's TEXT reach another client on
  // two channels (the blocks push and the content-doc push — structure stays
  // relational, text is per-block CRDT), so B can briefly show the rows' half
  // (lines removed, line 1 still whole) or the text's (line 1 joined, line 3
  // still there) before the other lands — exactly as a two-line merge does.
  // What the single op guarantees is that no OTHER state exists to observe:
  // never the middle line gone with the end line kept, never a refusal that
  // leaves the delete half-done. Convergence is the assertion.
  const states = await recordedStates(b.page);
  console.log(
    `B rendered ${states.length} state(s):\n` +
      states.map((st) => `  ${JSON.stringify(st)}`).join("\n"),
  );
  r.eq("B's last rendered state is the joined line", states.at(-1), [JOINED]);

  // Undo in A restores both clients.
  await a.page.keyboard.press("ControlOrMeta+z");
  await a.page.waitForTimeout(2500);
  r.eq("A: Cmd+Z restores the three lines", await blockTexts(a.page), LINES);
  const restored = await b.page
    .waitForFunction(
      (expected) =>
        JSON.stringify(
          [
            ...document.querySelectorAll(
              '[data-block-id] [contenteditable="true"]',
            ),
          ].map((el) => (el.textContent ?? "").trim()),
        ) === expected,
      JSON.stringify(LINES),
      { timeout: 15_000 },
    )
    .then(
      () => true,
      (err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return false;
        throw err;
      },
    );
  r.ok("B converges back to the three lines", restored);

  await r.finish();
});
