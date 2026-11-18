// Verifies caret navigation across SOFT LINES and INLINE DECORATORS inside the
// page block editor — the two families that used to break because a DOM Range
// paints nothing at those positions:
//
//  A. Empty soft lines — ArrowDown/ArrowUp on an EMPTY line inside a multi-line
//     block must move to the neighbouring LINE, never jump to the neighbouring
//     BLOCK. (`caretLineRect` borrows the `<br>`'s box when the collapsed range
//     reports none; the old code read "no rect" as "on both edges".)
//  B. Re-entering a multi-line block from below lands on its LAST line, not its
//     first. (`placeCaretAtColumn` aims at the last LINE BOX, not at an offset
//     from the editor's padded box.)
//  C. An inline decorator (a `@date` chip) is crossed by ONE ArrowLeft /
//     ArrowRight, landing on a caret position that is actually painted.
//
// Usage: bun plugins/page/plugins/editor/e2e/soft-line-caret-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage, editableBlocks } from "./support/blank-page";

const r = report();

interface CaretProbe {
  /** The block the caret is in, or null when it is nowhere. */
  block: string | null;
  /** Zero-based visual line within that block, derived from the caret's line box. */
  line: number;
  /** Whether the caret sits at a position the browser actually paints. */
  painted: boolean;
}

/**
 * Where the caret is, in (block, visual line) terms — read the same way the
 * editor reads it, so a green run here means the editor's own geometry agrees.
 */
async function caretAt(page: Page): Promise<CaretProbe> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0)
      return { block: null, line: -1, painted: false };
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    const el =
      container.nodeType === 1
        ? (container as Element)
        : container.parentElement;
    const blockEl = el?.closest("[data-block-id]");
    const editable = el?.closest("[data-block-text]");

    const usable = (rc: DOMRect | undefined) =>
      rc && (rc.width !== 0 || rc.height !== 0) ? rc : null;
    const direct = usable(range.getClientRects()[0]);
    // Same borrow the editor performs: the child at the anchor offset is on the
    // caret's own line.
    const borrow = (node: Node | undefined, last: boolean) => {
      if (!node) return null;
      const rr = document.createRange();
      if (node.nodeType === Node.TEXT_NODE) rr.selectNodeContents(node);
      else rr.selectNode(node);
      const rects = [...rr.getClientRects()].filter(
        (x) => x.width !== 0 || x.height !== 0,
      );
      return rects.length
        ? last
          ? rects[rects.length - 1]!
          : rects[0]!
        : null;
    };
    const caretRect =
      direct ??
      (container.nodeType === 1
        ? (borrow(container.childNodes[range.startOffset], false) ??
          borrow(container.childNodes[range.startOffset - 1], true))
        : null);

    // Line index = how many distinct line tops in the block sit above the caret's.
    let line = -1;
    if (caretRect && editable) {
      const tops = new Set<number>();
      for (const br of editable.querySelectorAll("br")) {
        const rr = document.createRange();
        rr.selectNode(br);
        const rc = rr.getBoundingClientRect();
        if (rc.height !== 0) tops.add(Math.round(rc.top));
      }
      for (const node of editable.querySelectorAll("span,p")) {
        for (const rc of node.getClientRects()) {
          if (rc.height !== 0 && rc.height < 40) tops.add(Math.round(rc.top));
        }
      }
      const sorted = [...tops].sort((a, b) => a - b);
      line = sorted.findIndex(
        (t) => Math.abs(t - Math.round(caretRect.top)) <= 3,
      );
    }
    return {
      block: blockEl?.getAttribute("data-block-id") ?? null,
      line,
      painted: direct !== null,
    };
  });
}

await withBrowser(async (h) => {
  // ===========================================================================
  // A + B. Soft lines, including empty ones
  // ===========================================================================
  console.log("\n=== Scenario A/B: empty soft lines ===");
  {
    const { context, page } = await h.session();
    await openBlankPage(page, { settleMs: 3000, timeoutMs: 120_000 });

    // Block 1: "aaa" / "bbb" / "" / ""   (four visual lines, two of them empty)
    await page.keyboard.type("aaa");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("bbb");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    // Block 2, so there is somewhere to wrongly jump to.
    await page.keyboard.press("Enter");
    await page.keyboard.type("ZZZ");
    await page.waitForTimeout(1500);

    r.ok("A: setup — two blocks", (await editableBlocks(page).count()) === 2);

    // Caret onto line 3 (the FIRST empty line) of block 1, via the last line.
    const first = editableBlocks(page).first();
    const box = (await first.boundingBox())!;
    await page.mouse.click(box.x + 5, box.y + box.height - 6);
    await page.waitForTimeout(400);
    const line4 = await caretAt(page);
    console.log("clicked last line:", JSON.stringify(line4));
    r.ok(
      "A: caret on block 1's last (empty) line",
      line4.line === 3,
      JSON.stringify(line4),
    );

    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(400);
    const line3 = await caretAt(page);
    console.log("after ArrowUp:", JSON.stringify(line3));
    r.ok(
      "A: ArrowUp from empty line 4 -> empty line 3, SAME block",
      line3.block === line4.block && line3.line === 2,
      JSON.stringify(line3),
    );

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
    const back4 = await caretAt(page);
    console.log("after ArrowDown:", JSON.stringify(back4));
    r.ok(
      "A: ArrowDown from empty line 3 -> line 4, SAME block (not the next block)",
      back4.block === line4.block && back4.line === 3,
      JSON.stringify(back4),
    );

    // One more Down leaves the block — that IS the bottom line.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(500);
    const nextBlock = await caretAt(page);
    console.log("after ArrowDown #2:", JSON.stringify(nextBlock));
    r.ok(
      "A: ArrowDown from the LAST line crosses to block 2",
      nextBlock.block !== null && nextBlock.block !== line4.block,
      JSON.stringify(nextBlock),
    );

    // B. ArrowUp from block 2 must land on block 1's LAST line, not its first.
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(500);
    const reentry = await caretAt(page);
    console.log("re-entry from below:", JSON.stringify(reentry));
    r.ok(
      "B: ArrowUp back into block 1 lands on its LAST line",
      reentry.block === line4.block && reentry.line === 3,
      JSON.stringify(reentry),
    );

    await context.close();
  }

  // ===========================================================================
  // C. Crossing an inline date chip
  // ===========================================================================
  console.log("\n=== Scenario C: inline decorator crossing ===");
  {
    const { context, page } = await h.session();
    await openBlankPage(page, { settleMs: 3000, timeoutMs: 120_000 });

    // "pre [chip] yy" — text on BOTH sides, the case the user reported.
    await page.keyboard.type("pre @today");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Enter"); // commit the date option
    await page.waitForTimeout(700);
    await page.keyboard.type("yy");
    await page.waitForTimeout(1000);

    // Caret is after "yy"; walk left to just after the chip (3 presses over " yy").
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(200);
    }
    const beforeCross = await caretAt(page);
    r.ok(
      "C: setup — caret painted just after the chip",
      beforeCross.painted,
      JSON.stringify(beforeCross),
    );

    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(300);
    const crossed = await caretAt(page);
    console.log("one ArrowLeft across the chip:", JSON.stringify(crossed));
    r.ok(
      "C: ONE ArrowLeft crosses the chip and the caret is still painted",
      crossed.painted,
      JSON.stringify(crossed),
    );
    const textBefore = await page.evaluate(() => {
      const sel = window.getSelection();
      const rng = sel?.getRangeAt(0);
      return rng
        ? `${rng.startContainer.textContent}@${rng.startOffset}`
        : "none";
    });
    console.log("caret sits in:", textBefore);
    r.ok(
      "C: it landed in the text BEFORE the chip",
      textBefore.startsWith("pre "),
      textBefore,
    );

    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    const backOver = await caretAt(page);
    console.log("one ArrowRight back:", JSON.stringify(backOver));
    r.ok(
      "C: ONE ArrowRight crosses back, caret painted",
      backOver.painted,
      JSON.stringify(backOver),
    );

    await context.close();
  }

  console.log("\n=== SUMMARY ===");
  await r.finish();
});
