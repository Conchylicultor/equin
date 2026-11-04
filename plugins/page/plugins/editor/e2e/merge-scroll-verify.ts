// A Backspace-merge must not move the text ABOVE the caret.
//
// Repro of the "top of the page changed to a different block" report: on a
// scrolled page, Backspace at the start of a long paragraph whose line above is
// EMPTY merges the paragraph into that empty line. The target grows from one
// visual line to several while the source (the focused block, below it) is still
// mounted; the browser's scroll anchoring, anchored on the source, scrolled the
// page by the target's growth — every line above the caret jumped up.
//
// Asserts: the first line in view and the joined line keep their viewport y
// (±2px) across the merge, and the merge really happened.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/merge-scroll-verify.ts [--out /tmp/merge-scroll]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockTexts, openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const out = arg("out", "/tmp/merge-scroll");
const r = report();

const LONG =
  "I noticed that when Claude failed, it was often because the agent had thought about the problem differently than a human would. So I started writing skills that teach Claude to think more like us, like the building blocks of cognition, one line after another.";

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "merge-scroll" });
  await page.setViewportSize({ width: 1100, height: 700 });
  await openBlankPage(page, { settleMs: 2000 });

  const lines: string[] = [];
  for (let i = 0; i < 24; i++) lines.push(`filler line ${i}`);
  lines.push("", LONG);
  for (let i = 0; i < 24; i++) lines.push(`after line ${i}`);
  await typeLines(page, lines);
  await page.waitForTimeout(2500);

  const longEditable = page
    .locator('[data-block-id] [contenteditable="true"]')
    .filter({ hasText: LONG.slice(0, 30) })
    .first();
  // Put the long paragraph in the middle of the viewport (scrolled page).
  await longEditable.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(500);

  const probe = () =>
    page.evaluate((long) => {
      const editables = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-block-id] [contenteditable="true"]',
        ),
      ];
      const firstVisible = editables.find(
        (el) => el.getBoundingClientRect().top >= 40,
      );
      const joined = editables.find((el) =>
        (el.textContent ?? "").startsWith(long.slice(0, 20)),
      );
      return {
        firstText: firstVisible?.textContent ?? null,
        firstTop: firstVisible?.getBoundingClientRect().top ?? null,
        joinedTop: joined?.getBoundingClientRect().top ?? null,
      };
    }, LONG);

  const before = await probe();
  console.log("before:", JSON.stringify(before));
  await snap(page, out, "1-before");

  // Caret to offset 0 of the long paragraph (Home is unreliable headless).
  await longEditable.click({ position: { x: 2, y: 10 } });
  await page.waitForTimeout(300);
  const mid = await probe();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(1500);
  const after = await probe();
  console.log("after click:", JSON.stringify(mid));
  console.log("after merge:", JSON.stringify(after));
  await snap(page, out, "2-after");

  const texts = await blockTexts(page);
  r.ok(
    "merge: the empty line took the paragraph (one block holds it, no blank above)",
    texts.filter((t) => t === LONG).length === 1 &&
      texts[texts.indexOf(LONG) - 1] === "filler line 23",
    JSON.stringify(texts.slice(22, 27)),
  );
  r.ok(
    "the first line in view did not move",
    after.firstText === mid.firstText &&
      mid.firstTop !== null &&
      after.firstTop !== null &&
      Math.abs(after.firstTop - mid.firstTop) <= 2,
    `${mid.firstText}@${mid.firstTop} -> ${after.firstText}@${after.firstTop}`,
  );
  r.ok(
    "the joined line stays where the line above it was",
    mid.joinedTop !== null &&
      after.joinedTop !== null &&
      after.joinedTop < mid.joinedTop &&
      mid.joinedTop - after.joinedTop < 60,
    `${mid.joinedTop} -> ${after.joinedTop}`,
  );

  await r.finish();
});
