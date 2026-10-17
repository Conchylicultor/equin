// Bare-id smart chips inside a Pages block — the browser half of
// `research/2026-08-25-global-inline-chips-in-pages.md`.
//
// Six claims, each of which only a real browser can settle:
//
//  1. PASTE MATERIALIZES A CHIP. Pasting single-line text carrying an `att-…`
//     id into a block produces a decorator node, not literal characters. The
//     paste plugin declines when the clipboard carries
//     `application/x-lexical-editor`, so an intra-app Meta+C/Meta+V would prove
//     nothing — the clipboard here is written with `navigator.clipboard.
//     writeText`, which sets `text/plain` and nothing else, exactly as a paste
//     from outside the app does.
//  2. THE CHIP SURVIVES A RELOAD. It is a node in the block's CRDT doc, not a
//     render-time decoration over text — so a full reload rebuilds it from the
//     doc, and nothing re-scans text.
//  3. TYPING AN ID DOES NOT CHIP IT. Paste-only is the declared behaviour (an id
//     is only briefly complete while typing). Pinned so that adding a type-time
//     transform later is a deliberate decision, not an accident.
//  4. AN ID INSIDE INLINE CODE STAYS CODE. `matchTokens` yields nothing for a
//     run carrying the `code` mark. Three routes reach a code-marked id and they
//     do NOT agree, so all three are asserted separately: (a) formatting it as
//     code in the editor, (b) pasting markdown that spells it with backticks,
//     and (c) seeding a new block from an already-code-marked run.
//  5. CLICKING A CHIP OPENS THE ATTEMPT PANE. Cross-app: the chip lives in the
//     Pages app and the attempt pane belongs to the agent manager.
//  6. AN ID INSIDE A URL DOES NOT CHIP. `inlineBoundary`'s `(?<!\/)` is what
//     keeps `https://x.dev/att-…` plain.
//
// Usage:
//   bun plugins/page/plugins/editor/e2e/inline-chips.ts [--url <deploy>]
//        [--attempt att-…] [--out /tmp/inline-chips] [--headed]
import {
  agentFetch,
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Locator, Page } from "playwright";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";
import { blockSelectionDriver } from "./support/block-selection";
import { makeRunsReader, type NormRun } from "./support/runs";

const out = arg("out", "/tmp/inline-chips");
// This worktree's own attempt id — a real row, so the chip resolves to a live
// status dot rather than the degraded raw-id arm.
const ATTEMPT = arg("attempt", "att-1787654245-y41m");

const r = report("page editor — inline chips");
const { settledRuns } = makeRunsReader();

/** Lexical stamps every decorator's host element with this. A chip IS one. */
const DECORATOR = '[data-lexical-decorator="true"]';

const decoratorsIn = (block: Locator) => block.locator(DECORATOR);

/** A block's text as the reader sees it, NBSP normalised. */
const textOf = async (block: Locator): Promise<string> =>
  (await block.innerText()).replace(/ /g, " ").trim();

/**
 * Paste `text` as an EXTERNAL paste would.
 *
 * `navigator.clipboard.writeText` puts `text/plain` on the clipboard and
 * nothing else — no `application/x-lexical-editor` — which is the clipboard
 * shape `TokenPastePlugin` requires. Meta+V then drives the real
 * `PASTE_COMMAND`, so every registered handler races in its true priority
 * order, exactly as it does for a human.
 */
async function pasteExternal(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(800);
}

/** Every editable block's text, in document order. */
async function documentTexts(page: Page): Promise<string[]> {
  const blocks = editableBlocks(page);
  const n = await blocks.count();
  const texts: string[] = [];
  for (let i = 0; i < n; i++) texts.push(await textOf(blocks.nth(i)));
  return texts;
}

/** Every editable block whose text starts with `prefix`, in document order. */
async function blocksStartingWith(
  page: Page,
  prefix: string,
): Promise<Locator[]> {
  const blocks = editableBlocks(page);
  const n = await blocks.count();
  const hits: Locator[] = [];
  for (let i = 0; i < n; i++) {
    if ((await textOf(blocks.nth(i))).startsWith(prefix))
      hits.push(blocks.nth(i));
  }
  return hits;
}

/** The first editable block whose text starts with `prefix`. */
async function blockStartingWith(
  page: Page,
  prefix: string,
): Promise<Locator | null> {
  return (await blocksStartingWith(page, prefix))[0] ?? null;
}

/**
 * Extend the selection leftwards until it covers exactly the last `n`
 * characters, returning what it ended up covering.
 *
 * A loop rather than `n` presses: a mark boundary owns a virtual stop that can
 * absorb one, so a fixed count silently ends up collapsed — and a collapsed
 * caret makes the code shortcut ARM the next character instead of marking the
 * selection, which then reads as "the mark did not persist" three lines later.
 * Lifted from `format-shortcuts-verify.ts`, which pays the same toll.
 */
async function selectLastChars(page: Page, n: number): Promise<string> {
  const read = () =>
    page.evaluate(() => window.getSelection()?.toString() ?? "");
  for (let guard = 0; guard <= n + 4; guard++) {
    if ((await read()).length === n) return read();
    await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForTimeout(60);
  }
  return read();
}

/**
 * Wait until a freshly created block exists on the SERVER.
 *
 * A split block mounts its editor from the optimistic overlay before its
 * `page_blocks` row is created, and its content doc cannot seed until that row
 * is confirmed — so typing into the gap races the seed.
 */
async function awaitRow(
  page: Page,
  pageId: string,
  blockId: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await agentFetch(`/api/pages/${pageId}/blocks`);
    const rows = (await res.json()) as { id: string }[];
    if (rows.some((row) => row.id === blockId)) break;
    if (Date.now() > deadline)
      throw new Error(`block ${blockId} never reached the server`);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(800);
}

/** A one-line description of what a block is actually made of, for a FAIL line. */
async function shapeOf(block: Locator): Promise<string> {
  return block.evaluate((el) =>
    [...el.querySelectorAll("*")]
      .map((n) => {
        const tag = n.tagName.toLowerCase();
        const dec = n.getAttribute("data-lexical-decorator") ? "*" : "";
        return `${tag}${dec}`;
      })
      .join(" "),
  );
}

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    // A permission grant is scoped to a security ORIGIN, not a page — so this
    // is one of the few places that legitimately wants the origin, derived
    // from a URL rather than carried around as one.
    origin: new URL(pathUrl("/")).origin,
  });

  const { pageUrl, pageId, block, blockId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  r.note(`page ${pageUrl}`);

  // ---- 1. paste materializes a chip -----------------------------------------
  await block.click();
  await pasteExternal(page, `see ${ATTEMPT} here`);
  await page.waitForTimeout(1200);
  await snap(page, out, "1-pasted");

  const pastedDecorators = await decoratorsIn(block).count();
  r.ok(
    "1. paste: the id became a decorator node, not characters",
    pastedDecorators === 1,
    `decorators=${pastedDecorators} shape=[${await shapeOf(block)}]`,
  );

  const chip = block.locator(`button[data-tooltip*="${ATTEMPT}"]`).first();
  const chipCount = await block
    .locator(`button[data-tooltip*="${ATTEMPT}"]`)
    .count();
  r.ok(
    "1. paste: the decorator rendered the attempt chip",
    chipCount === 1,
    `chip buttons=${chipCount}`,
  );
  if (chipCount === 1) {
    r.note(`chip tooltip="${await chip.getAttribute("data-tooltip")}"`);
  }

  const pastedText = await textOf(block);
  r.ok(
    "1. paste: the surrounding words survived",
    pastedText.startsWith("see") && pastedText.endsWith("here"),
    `text="${pastedText}"`,
  );

  const pastedRuns: NormRun[] = await settledRuns(page, pageId, blockId);
  r.ok(
    "1. paste: the token persisted into data.text",
    pastedRuns.some((run) => run.text.includes(ATTEMPT)),
    JSON.stringify(pastedRuns),
  );

  // ---- 6. an id inside a URL stays plain -------------------------------------
  // Deliberately NOT a bare URL: a bare URL into an empty block is claimed by
  // `UrlPastePlugin` (bookmark), which would prove nothing about the boundary
  // guard. With words either side, `TokenPastePlugin` is the handler that sees
  // it — and must decline, because `inlineBoundary`'s `(?<!\/)` means the id
  // inside the path is not a token at all.
  await block.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const urlBlock = editableBlocks(page).nth(1);
  const urlBlockId = await blockIdOf(urlBlock);
  await pasteExternal(page, `docs at https://x.dev/${ATTEMPT} ok`);
  await page.waitForTimeout(800);

  const urlDecorators = await decoratorsIn(urlBlock).count();
  const urlText = await textOf(urlBlock);
  r.ok(
    "6. url: an id inside a URL path did NOT chip",
    urlDecorators === 0,
    `decorators=${urlDecorators} shape=[${await shapeOf(urlBlock)}]`,
  );
  r.ok(
    "6. url: the URL is still there, whole",
    urlText.includes(`https://x.dev/${ATTEMPT}`),
    `text="${urlText}"`,
  );

  // ---- 3. typing an id does NOT chip it --------------------------------------
  await urlBlock.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const typedBlock = editableBlocks(page).nth(2);
  const typedBlockId = await blockIdOf(typedBlock);
  await page.keyboard.type(`typed ${ATTEMPT} end`);
  await page.waitForTimeout(1200);
  await snap(page, out, "3-typed");

  const typedDecorators = await decoratorsIn(typedBlock).count();
  r.ok(
    "3. typing: an id typed by hand stays plain text (paste-only, by design)",
    typedDecorators === 0,
    `decorators=${typedDecorators} shape=[${await shapeOf(typedBlock)}]`,
  );
  const typedRuns = await settledRuns(page, pageId, typedBlockId);
  r.ok(
    "3. typing: the characters persisted as text",
    typedRuns.some((run) => run.text.includes(ATTEMPT)),
    JSON.stringify(typedRuns),
  );

  // ---- 4a. formatting an id as code in the editor ----------------------------
  // The route a person takes inside the document: write the id, select it, press
  // the code shortcut. Nothing here goes through `matchTokens` — the block's doc
  // already exists — so this is the baseline the other two routes are read
  // against: does a code-marked id even survive as code?
  await typedBlock.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const codeArmBlock = editableBlocks(page).nth(3);
  const codeArmBlockId = await blockIdOf(codeArmBlock);
  await awaitRow(page, pageId, codeArmBlockId);
  await page.keyboard.type(`codearm ${ATTEMPT}`, { delay: 25 });
  await page.waitForTimeout(600);
  // The id is the tail of the line, so no ArrowLeft walk is needed first — one
  // less thing a virtual mark stop can absorb.
  const selected = await selectLastChars(page, ATTEMPT.length);
  r.eq("4a. editor: the id is the selected range", selected, ATTEMPT);
  await page.keyboard.press("ControlOrMeta+e");
  await page.waitForTimeout(1200);
  await snap(page, out, "4a-code-armed");

  r.ok(
    "4a. editor: an id formatted as code in place is not a widget",
    (await decoratorsIn(codeArmBlock).count()) === 0,
    `shape=[${await shapeOf(codeArmBlock)}]`,
  );
  const armedRuns = await settledRuns(page, pageId, codeArmBlockId);
  const armedIsCode = armedRuns.some(
    (run) => run.text.includes(ATTEMPT) && run.marks.includes("code"),
  );
  r.ok(
    "4a. editor: the code mark persisted onto the id's run",
    armedIsCode,
    JSON.stringify(armedRuns),
  );

  // ---- 4c. seeding a NEW block from an already-code-marked run ---------------
  // Copying that block and pasting it mints a new block whose doc is seeded from
  // the copied runs — which is the path `matchTokens`' code-mark skip actually
  // governs. Done before 4b because it needs 4a's block intact.
  if (armedIsCode) {
    const selection = blockSelectionDriver(page, r);
    await selection.enterBlockSelection("4c. copy the code-marked block", 3);
    await page.keyboard.press("ControlOrMeta+c");
    await page.waitForTimeout(600);
    await page.keyboard.press("ControlOrMeta+v");
    await page.waitForTimeout(2500);
    await snap(page, out, "4c-seeded");

    const seeded = await blocksStartingWith(page, "codearm");
    r.ok(
      "4c. seed: the code-marked block was duplicated",
      seeded.length === 2,
      `blocks starting with "codearm" = ${seeded.length}`,
    );
    const copy = seeded.at(-1);
    if (copy) {
      const n = await decoratorsIn(copy).count();
      r.ok(
        "4c. seed: a code-marked id seeded into a new block stayed code, not a chip",
        n === 0,
        `decorators=${n} shape=[${await shapeOf(copy)}]`,
      );
      const copyRuns = await settledRuns(page, pageId, await blockIdOf(copy));
      r.ok(
        "4c. seed: the copy's persisted run still carries the code mark",
        copyRuns.some(
          (run) => run.text.includes(ATTEMPT) && run.marks.includes("code"),
        ),
        JSON.stringify(copyRuns),
      );
    }
  } else {
    r.note("4c skipped — 4a never produced a code-marked run to seed from");
  }

  // ---- 4b. pasting markdown that spells the id as inline code -----------------
  // A MULTI-LINE paste goes through `BlockForestPastePlugin` → markdown → new
  // blocks. Both arms in one paste: a plain line (must chip) and a backticked
  // line (must not).
  const lastBlock = editableBlocks(page).last();
  await lastBlock.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await pasteExternal(
    page,
    `plainline ${ATTEMPT} tail\ncodeline \`${ATTEMPT}\` tail`,
  );
  await page.waitForTimeout(2000);
  await snap(page, out, "4-code");
  r.note(`document: ${JSON.stringify(await documentTexts(page))}`);

  const plainSeeded = await blockStartingWith(page, "plainline");
  const codeSeeded = await blockStartingWith(page, "codeline");

  if (!plainSeeded) {
    r.fail("4b. seed: the plain markdown line became its own block");
  } else {
    const n = await decoratorsIn(plainSeeded).count();
    r.ok(
      "4b. seed: a plain id in a seeded block became a chip",
      n === 1,
      `decorators=${n} shape=[${await shapeOf(plainSeeded)}]`,
    );
  }

  if (!codeSeeded) {
    r.fail("4b. code: the backticked markdown line became its own block");
  } else {
    const n = await decoratorsIn(codeSeeded).count();
    const codeEls = await codeSeeded.locator("code").count();
    const codeText = await textOf(codeSeeded);
    r.ok(
      "4b. code: an id inside inline code did NOT become a widget",
      n === 0,
      `decorators=${n} shape=[${await shapeOf(codeSeeded)}]`,
    );
    r.ok(
      "4b. code: it is still rendered as code",
      codeEls > 0,
      `<code> elements=${codeEls} shape=[${await shapeOf(codeSeeded)}]`,
    );
    r.ok(
      "4b. code: the id is still readable in it",
      codeText.includes(ATTEMPT),
      `text="${codeText}"`,
    );
    const codeBlockId = await blockIdOf(codeSeeded);
    const codeRuns = await settledRuns(page, pageId, codeBlockId);
    r.ok(
      "4b. code: the persisted run carries the code mark",
      codeRuns.some(
        (run) => run.text.includes(ATTEMPT) && run.marks.includes("code"),
      ),
      JSON.stringify(codeRuns),
    );
  }

  // ---- 2. the chip survives a reload -----------------------------------------
  await page.waitForTimeout(2500); // let every doc flush before tearing the page down
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await editableBlocks(page).first().waitFor({ state: "visible" });
  await page.waitForTimeout(3000);
  await snap(page, out, "2-reloaded");

  const reloadedBlock = page
    .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
    .first();
  const reloadedDecorators = await decoratorsIn(reloadedBlock).count();
  r.ok(
    "2. reload: the chip is still a decorator after a full reload",
    reloadedDecorators === 1,
    `decorators=${reloadedDecorators} shape=[${await shapeOf(reloadedBlock)}]`,
  );
  const reloadedTyped = page
    .locator(`[data-block-id="${typedBlockId}"] [contenteditable="true"]`)
    .first();
  r.ok(
    "2. reload: the TYPED id is still plain (a reload does not re-scan text)",
    (await decoratorsIn(reloadedTyped).count()) === 0,
  );
  r.note(
    `url-block after reload: "${await textOf(page.locator(`[data-block-id="${urlBlockId}"] [contenteditable="true"]`).first())}"`,
  );

  // ---- 5. clicking the chip opens the attempt pane ---------------------------
  const reloadedChip = reloadedBlock
    .locator(`button[data-tooltip*="${ATTEMPT}"]`)
    .first();
  if (
    (await reloadedBlock
      .locator(`button[data-tooltip*="${ATTEMPT}"]`)
      .count()) === 0
  ) {
    r.fail("5. click: no chip to click after the reload");
  } else {
    await reloadedChip.click();
    await page.waitForTimeout(2500);
    await snap(page, out, "5-clicked");
    const url = page.url();
    r.ok(
      "5. click: the URL moved to the attempt",
      url.includes(`a/${ATTEMPT}`),
      `url=${url}`,
    );
    const paneIds: string[] = await page
      .locator("[data-pane-id]")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-pane-id") ?? "?"),
      );
    r.note(`panes=${JSON.stringify(paneIds)}`);
    r.ok(
      "5. click: the attempt pane is open",
      paneIds.includes("attempt"),
      `panes=${JSON.stringify(paneIds)}`,
    );
  }
});

await r.finish();
