// The editor's caret reaches EVERY block type, and what it means on a media
// block once it gets there.
//
// Two phases, deliberately different in kind:
//
//  1. A generic sweep. Every block type the `/` menu offers is inserted and
//     asked one question: after inserting you, is the keyboard somewhere? The
//     answer must be a real editing host — a `contenteditable`, a `<textarea>` a
//     block owns — or a `[data-caret-host]`, and it must be inside a block row.
//     The types are read off
//     the running app at runtime rather than imported, so a TENTH media block
//     added next year is covered by this script without editing it — an editor
//     spec that hard-named nine contributor plugins would be the
//     collection-consumer inversion the root CLAUDE.md warns about, and it would
//     silently pass while missing the one type nobody remembered.
//
//  2. The meaning, driven on the image block: arrowing INTO the object rather
//     than over it, Enter's two arms (an unfilled block runs its own action; a
//     filled one starts a paragraph below), and Backspace deleting the whole
//     object in one press.
//
// Usage: bun plugins/page/plugins/editor/e2e/media-caret-verify.ts \
//          [--url <deploy>] [--out /tmp/media-caret] [--image <path>]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/media-caret");
const image = arg("image", "/tmp/test-image.png");
const r = report("media-caret");

/**
 * Where is the keyboard right now, in the editor's own vocabulary?
 *
 * Three answers are legitimate, one per way a block can hold the caret, and the
 * sweep below asserts the keyboard is in one of them:
 *
 * - `inText` — a text-bearing block's Lexical editing host, where the browser
 *   paints a real caret;
 * - `inTextControl` — a native `<textarea>` / `<input>` a `caret: "renderer"`
 *   block owns (code-block's and equation's source), which is also a real caret,
 *   just not a `contenteditable` one;
 * - `onCaretHost` — the editor's own void-block host.
 *
 * Anything else means the keyboard is nowhere the editor knows about, which is
 * the bug this whole spec exists for.
 */
interface CaretPlace {
  /** `data-block-id` of the row holding DOM focus, if any. */
  blockId: string | null;
  inText: boolean;
  inTextControl: boolean;
  onCaretHost: boolean;
  /** The host's accessible name, which is the block type's insert-menu label. */
  label: string | null;
}

function caretIsSomewhere(p: CaretPlace): boolean {
  return p.inText || p.inTextControl || p.onCaretHost;
}

async function caretPlace(page: Page): Promise<CaretPlace> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const tag = el?.tagName;
    return {
      blockId:
        el?.closest("[data-block-id]")?.getAttribute("data-block-id") ?? null,
      inText: el !== null && el.closest("[data-block-text]") !== null,
      inTextControl: tag === "TEXTAREA" || tag === "INPUT",
      onCaretHost: el?.dataset.caretHost !== undefined,
      label: el?.getAttribute("aria-label") ?? null,
    };
  });
}

/**
 * Every block type the `/` menu offers, by its visible label — the runtime read
 * that keeps this script from naming contributor plugins.
 *
 * Opened from an empty block, so the menu is unfiltered and lists the whole
 * registry rather than whatever matched a query.
 */
async function insertableTypes(
  page: Page,
): Promise<{ type: string; label: string }[]> {
  await page.keyboard.type("/", { delay: 40 });
  await page.waitForTimeout(700);
  const types = await page.evaluate(() =>
    [...document.querySelectorAll("[data-block-type]")].map((el) => ({
      type: el.getAttribute("data-block-type") ?? "",
      label: (el.textContent ?? "").trim(),
    })),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  return types.filter((t) => t.type.length > 0 && t.label.length > 0);
}

await withBrowser(async (h) => {
  // ── Phase 1: every insertable type is caret-reachable ─────────────────────
  //
  // Its own browser session, because it is 20+ page creations that leave the
  // context in a state the behaviour phase should not inherit: sharing one
  // session made Chromium stop honouring the file-dialog open that phase 2
  // presses Enter for, while the same press works in a fresh context. Two
  // phases, two questions, two sessions.
  {
    const { page } = await h.session({ label: "sweep" });
    const doc = await openBlankPage(page, {
      settleMs: 3000,
      timeoutMs: 60_000,
    });
    r.note(`sweep page ${doc.pageId}`);

    const types = await insertableTypes(page);
    if (types.length === 0) {
      // Loud, not a quiet skip: an empty menu means the read below verified
      // nothing at all, which must never look like a clean pass.
      r.fail(
        "the `/` menu lists at least one block type",
        "no [data-block-type] entries found — the sweep verified nothing",
      );
    } else {
      r.note(`insertable types: ${types.map((t) => t.type).join(", ")}`);
      for (const { type, label } of types) {
        // A fresh page per type. Stacking them into ONE document instead was
        // tried and is worse: the document grows past the viewport, so the
        // "click below the last block" gesture that opens a new trailing line
        // lands off-screen and every later type reports focus nowhere — a cascade
        // of failures that says nothing about the invariant. The generous
        // timeout is because this is 20+ page creations back to back on a host
        // that may also be building.
        await openBlankPage(page, { settleMs: 1200, timeoutMs: 60_000 });
        await page.keyboard.type(`/${label}`, { delay: 30 });
        await page.waitForTimeout(600);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1200);

        const place = await caretPlace(page);
        r.ok(
          `"${type}": the keyboard is somewhere after inserting it`,
          caretIsSomewhere(place) && place.blockId !== null,
          JSON.stringify(place),
        );
      }
    }
  }

  // ── Phase 2: what the caret MEANS on a media object ───────────────────────
  const { page } = await h.session({ label: "behaviour" });
  const doc = await openBlankPage(page, {
    settleMs: 2500,
    timeoutMs: 60_000,
  });
  r.note(`behaviour page ${doc.pageId}`);

  await page.keyboard.type("above the image", { delay: 20 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.type("/Image", { delay: 30 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);

  const onInsert = await caretPlace(page);
  r.ok(
    "an inserted image block holds the caret on its own host",
    onInsert.onCaretHost && onInsert.label === "Image",
    JSON.stringify(onInsert),
  );
  const imageBlockId = onInsert.blockId;
  await snap(page, out, "1-empty-image-focused");

  if (!imageBlockId) {
    r.fail("image block id resolvable", "nothing focused after insert");
  } else {
    // --- Enter on an UNFILLED block runs its ACTIVATION, not the fallback ----
    // The contract is "an unfilled media block is a prompt, so Enter fills it
    // rather than starting a new line". What is observable is the second half:
    // the paragraph the host would otherwise insert does NOT appear, and the
    // caret stays put.
    //
    // The first half — the file dialog actually opening — is deliberately NOT
    // asserted here. Chromium refuses to open a file dialog from a KEY event in
    // this page state (a page-owned keydown listener clicking the very same
    // hidden input is refused identically, while a mouse click on the dropzone
    // opens it), so an assertion on the dialog would be testing the harness, not
    // the editor. The upload path is exercised through the input below instead,
    // which is how the image block's own e2e has always driven it.
    const rowsBeforeEnter = await page.locator("[data-block-id]").count();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    const afterPromptEnter = await caretPlace(page);
    r.ok(
      "Enter on an unfilled image block runs its own action, not 'paragraph below'",
      (await page.locator("[data-block-id]").count()) === rowsBeforeEnter &&
        afterPromptEnter.onCaretHost &&
        afterPromptEnter.blockId === imageBlockId,
      JSON.stringify(afterPromptEnter),
    );

    // --- Fill it, so the rest runs against a real object ---------------------
    await page.setInputFiles('input[type="file"]', image);
    await page
      .locator(`[data-block-id="${imageBlockId}"] img`)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(600);
    await snap(page, out, "2-filled");

    // --- Arrowing DOWN from the paragraph above lands ON the object ----------
    // The whole bug, in one assertion: `navigate()` used to walk past a block
    // with no registered handle, so this landed on whatever came after.
    await page
      .locator(`[data-block-id="${doc.blockId}"] [data-block-text]`)
      .first()
      .click();
    await page.waitForTimeout(400);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(500);
    const arrived = await caretPlace(page);
    r.ok(
      "ArrowDown from the paragraph above lands ON the image, not past it",
      arrived.onCaretHost && arrived.blockId === imageBlockId,
      JSON.stringify(arrived),
    );
    await snap(page, out, "3-caret-on-image");

    // --- Enter on a FILLED block starts a paragraph below --------------------
    const rowsBefore = await page.locator("[data-block-id]").count();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    const afterEnter = await caretPlace(page);
    const rowsAfter = await page.locator("[data-block-id]").count();
    r.ok(
      "Enter on a filled image opens a text block below and puts the caret in it",
      afterEnter.inText &&
        afterEnter.blockId !== imageBlockId &&
        rowsAfter === rowsBefore + 1,
      JSON.stringify({ afterEnter, rowsBefore, rowsAfter }),
    );

    // --- Backspace from the block below lands on the image, then deletes it --
    // Two presses, one continuous motion: the first refuses to merge into a
    // block that carries no text and falls through to a boundary nav; the
    // second is the object's own Backspace.
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(600);
    const backOnto = await caretPlace(page);
    r.ok(
      "Backspace at the start of the block below lands the caret on the image",
      backOnto.onCaretHost && backOnto.blockId === imageBlockId,
      JSON.stringify(backOnto),
    );
    await snap(page, out, "4-backspaced-onto-image");

    if (backOnto.onCaretHost) {
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(900);
      const gone =
        (await page.locator(`[data-block-id="${imageBlockId}"]`).count()) === 0;
      r.ok("a second Backspace deletes the whole image block", gone);
      const landed = await caretPlace(page);
      r.ok(
        "…and leaves the caret in the paragraph above",
        landed.inText && landed.blockId === doc.blockId,
        JSON.stringify(landed),
      );
      await snap(page, out, "5-deleted");
    }
  }

  await r.finish();
});
