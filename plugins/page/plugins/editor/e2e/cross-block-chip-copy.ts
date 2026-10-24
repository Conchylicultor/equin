// Copying an inline chip out of one block and pasting it into the NEXT one.
//
// The gesture is ordinary and the clipboard path it takes is not. Every block is
// its own Lexical editor with its own namespace (`block-text-<blockId>`), and
// Lexical accepts its own `application/x-lexical-editor` payload only when
// `payload.namespace === editor._config.namespace` — so a copy that never leaves
// the app still cannot use it, and lands on the `text/html` arm instead. Only a
// real browser settles what that arm carries: the copy is a real Meta+C over a
// real selection, so the payload is the one the browser writes, not one a script
// synthesised.
//
// Three claims:
//
//  1. THE CHIP CROSSES. A chip pasted into block 2 is a decorator node there —
//     the same chip, not the blank that an empty `createDOM()` export produced.
//  2. IT IS THE SAME TOKEN. Its id survives into block 2's persisted runs, so it
//     is a real node in the CRDT doc and not a render-time decoration.
//  3. THE WORDS AROUND IT SURVIVE. The HTML arm carries the sentence too, which
//     is what makes declining this paste in `TokenPastePlugin` (which would
//     rebuild the token from `text/plain` and drop the marks) still correct.
//
// Usage:
//   ./equin run plugins/page/plugins/editor/e2e/cross-block-chip-copy.ts
//        [--attempt att-…] [--out /tmp/cross-block-chip] [--headed]
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Locator, Page } from "playwright";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";
import { makeRunsReader, type NormRun } from "./support/runs";

const out = arg("out", "/tmp/cross-block-chip");
/** This worktree's own attempt id — a real row, so the chip resolves. */
const ATTEMPT = arg("attempt", "att-1788945055-8q78");

const r = report("page editor — a chip copied between two blocks");
const { settledRuns } = makeRunsReader();

/** Lexical stamps every decorator's host element with this. A chip IS one. */
const DECORATOR = '[data-lexical-decorator="true"]';

const decoratorsIn = (block: Locator) => block.locator(DECORATOR);

/** A block's text as the reader sees it, NBSP normalised. */
const textOf = async (block: Locator): Promise<string> =>
  (await block.innerText()).replace(/ /g, " ").trim();

/** A one-line description of what a block is made of, for a FAIL line. */
async function shapeOf(block: Locator): Promise<string> {
  return block.evaluate((el) =>
    [...el.querySelectorAll("*")]
      .map(
        (n) =>
          `${n.tagName.toLowerCase()}${n.getAttribute("data-lexical-decorator") ? "*" : ""}`,
      )
      .join(" "),
  );
}

/**
 * Seed a chip the way a person does from OUTSIDE the app.
 *
 * `navigator.clipboard.writeText` writes `text/plain` and nothing else, which is
 * the clipboard shape `TokenPastePlugin` needs. The copy under test later is a
 * real Meta+C — that is the whole point of this script.
 */
async function pasteExternal(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(800);
}

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(pathUrl("/")).origin,
  });

  const { pageUrl, pageId, block, blockId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  r.note(`page ${pageUrl}`);

  // ---- seed: a chip in block 1 ----------------------------------------------
  await block.click();
  await pasteExternal(page, `see ${ATTEMPT} here`);
  await page.waitForTimeout(1200);

  const seeded = await decoratorsIn(block).count();
  r.ok(
    "seed: block 1 holds one chip",
    seeded === 1,
    `decorators=${seeded} shape=[${await shapeOf(block)}]`,
  );
  await snap(page, out, "1-seeded");

  // ---- copy the whole line out of block 1 -----------------------------------
  // Select-all inside the block rather than a character walk: the chip is one
  // atomic decorator, and a Shift+ArrowLeft count would have to know how many
  // steps it costs. `ContentScope` keeps Meta+A inside the block.
  await block.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.waitForTimeout(200);
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(400);
  // Not asserted from the script: `navigator.clipboard.read()` only surfaces
  // web-safe MIME types, so a custom `application/x-lexical-editor` flavour is
  // invisible to it whether or not the browser wrote one. What the payload
  // amounted to is settled below, by what the paste produced.

  // ---- paste it into a NEW block --------------------------------------------
  await page.keyboard.press("ArrowRight"); // collapse the selection to its end
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);

  const target = editableBlocks(page).nth(1);
  const targetId = await blockIdOf(target);
  await target.click();
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(1500);
  await snap(page, out, "2-pasted");

  // ---- 1. the chip crossed ---------------------------------------------------
  const crossed = await decoratorsIn(target).count();
  r.ok(
    "1. the chip crossed into block 2 as a decorator, not a blank",
    crossed === 1,
    `decorators=${crossed} shape=[${await shapeOf(target)}] text="${await textOf(target)}"`,
  );

  // ---- 2. it is the same token ----------------------------------------------
  const runs: NormRun[] = await settledRuns(page, pageId, targetId);
  r.ok(
    "2. the token persisted into block 2's runs",
    runs.some((run) => run.text.includes(ATTEMPT)),
    JSON.stringify(runs),
  );

  // ---- 3. the sentence survived ---------------------------------------------
  const text = await textOf(target);
  r.ok(
    "3. the words either side came with it",
    text.startsWith("see") && text.endsWith("here"),
    `text="${text}"`,
  );

  // The source block is untouched — a copy, not a move.
  const sourceStill = await decoratorsIn(editableBlocks(page).nth(0)).count();
  r.ok(
    "block 1 still holds its own chip",
    sourceStill === 1,
    `decorators=${sourceStill} blockId=${blockId}`,
  );
});
