// The editor's mark keyboard shortcuts — the table in
// `web/components/format-shortcuts-plugin.tsx`, end to end
// (research/2026-08-16-page-cmd-b-format-shortcut-double-dispatch.md).
//
// WHY THIS FILE EXISTS. Until it did, nothing asserted that the shortcut table
// applies its marks at all. `inline-format-verify.ts` covers marks applied by
// TYPING MARKDOWN; `mark-boundary-verify.ts` and `pending-marks-cue-verify.ts`
// press ⌘E only, and only as a fixture for something else. So four of the five
// shortcuts could be inert with nothing going red — and four of them WERE:
// Lexical's own `$handleKeyDown` has an `else if` branch for bold, italic and
// underline that dispatches `FORMAT_TEXT_COMMAND` before it dispatches the
// `KEY_MODIFIER_COMMAND` the plugin used to listen on, so those three toggled
// twice per press and therefore not at all. ⌘U is the ONLY way to apply
// underline (markdown has no syntax for it), so it had no other route either.
//
// THE SUBJECT OF THIS FILE IS THE PERSISTED ROWS (`GET /api/pages/:pageId/blocks`
// → `data.text`), because that is the only read that proves a mark travelled
// Lexical → the block's `Y.Doc` → the ~1s projection. A DOM-only read passes on a
// mark that never left the browser, and a collapsed caret's pending set is not in
// the DOM at all. The one exception is phase 4, whose claim IS a popover.
//
// The mark table below is the phases' only input, so a sixth entry in
// `SHORTCUTS` is one row here, not a new phase.
//
// Phases (every mark runs every phase, each in its own block):
//  1. COLLAPSED CARET — `aa`, the shortcut, `b` → [{aa}, {b, mark}]. The
//     shortcut arms the next character and nothing before it;
//  2. RANGE — `hello`, select it, the shortcut → [{hello, mark}]. The sturdier
//     of the two: a range format mutates the nodes outright, with no pending
//     state and no timing window anywhere in it;
//  3. TOGGLE OFF — same as 2 but pressed twice → [{hello}]. Phases 2 and 3 are
//     a PAIR and neither is meaningful alone: a shortcut that silently fires
//     twice per press fails 2 while passing 3, and one that force-SETS instead
//     of toggling passes 2 while failing 3. Only both together say "exactly one
//     toggle per press";
//  4. ⌘K still opens the link popover — the other branch of the same handler,
//     which shares its registration and must not regress with it.
//
// Manual-only; nothing runs this automatically.
// Usage: bun plugins/page/plugins/editor/e2e/format-shortcuts-verify.ts [--url <deploy>] [--out /tmp/format-shortcuts]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage } from "./support/blank-page";
import { makeRunsReader } from "./support/runs";

const out = arg("out", "/tmp/format-shortcuts");

const r = report();

const { fetchRows, settledRuns } = makeRunsReader();

// --- the table under test -----------------------------------------------------

/**
 * Every row of `SHORTCUTS` in `format-shortcuts-plugin.tsx`, in its order.
 *
 * Playwright's `ControlOrMeta` is Meta on macOS and Control everywhere else,
 * which is exactly the `event.metaKey || event.ctrlKey` the handler tests. The
 * strikethrough row carries `Shift`, and the handler compares `event.shiftKey`
 * against the row's own `shift` — so this is also the assertion that a shifted
 * row is not matched by its unshifted key and vice versa.
 */
const MARKS: { mark: string; press: string }[] = [
  { mark: "bold", press: "ControlOrMeta+b" },
  { mark: "italic", press: "ControlOrMeta+i" },
  { mark: "underline", press: "ControlOrMeta+u" },
  { mark: "code", press: "ControlOrMeta+e" },
  { mark: "strikethrough", press: "ControlOrMeta+Shift+x" },
];

// --- waits --------------------------------------------------------------------

/** A settle short enough that the next character really is the NEXT thing typed. */
const KEYSTROKE_MS = 150;

/**
 * Between a COLLAPSED-caret shortcut and the character it arms.
 *
 * Deliberately short, and not for speed. A collapsed-caret toggle lives in
 * `RangeSelection.format`, which survives indefinitely on its own — but if
 * anything re-derives the selection from the DOM in between, Lexical only carries
 * the format across that re-derivation for 200ms
 * (`$internalCreateRangeSelection`'s `currentTimeStamp < timeStamp + 200` branch,
 * keyed on `(anchor.key, offset)`). Typing promptly is what a user does and is
 * correct on BOTH paths, so this phase can never fail for a timing reason it is
 * not about. Phase 2 has no such window at all — which is why it, not this one,
 * is the load-bearing half.
 */
const ARM_MS = 120;

// --- DOM reads ----------------------------------------------------------------

/** Every editable block id in document order. */
async function editableIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")]
      .filter((el) => el.querySelector('[contenteditable="true"]'))
      .map((el) => el.getAttribute("data-block-id") ?? ""),
  );
}

const editableOf = (page: Page, blockId: string) =>
  page.locator(`[data-block-id="${blockId}"] [contenteditable="true"]`).first();

/** What the browser reports as selected, which is what a range format acts on. */
const selectedText = (page: Page) =>
  page.evaluate(() => window.getSelection()?.toString() ?? "");

// --- authoring ----------------------------------------------------------------

/**
 * A fresh empty block at the end of the document, whose id is returned.
 *
 * Clicks the right edge of the last block first, for two reasons at once: it
 * collapses whatever selection the previous phase left behind (Enter over a
 * range REPLACES it), and it parks the caret at the end of that block's one
 * short line, so Enter appends rather than splits.
 *
 * Then it WAITS FOR THE ROW. A freshly split block mounts its editor from the
 * optimistic overlay before the structural POST creates its `page_blocks` row,
 * and its content `Y.Doc` cannot seed until that row is confirmed — so typing
 * into that gap races the seed. Every sibling script pays this same toll.
 */
async function newBlock(page: Page, pageId: string): Promise<string> {
  const before = await editableIds(page);
  const last = before.at(-1);
  if (!last) throw new Error("document has no editable block");

  const editable = editableOf(page, last);
  const box = await editable.boundingBox();
  if (!box) throw new Error(`block ${last} has no box`);
  await editable.click({ position: { x: Math.max(box.width - 4, 4), y: 8 } });
  await page.waitForTimeout(200);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  const after = await editableIds(page);
  const fresh = after.filter((id) => !before.includes(id));
  if (fresh.length !== 1 || !fresh[0]) {
    throw new Error(
      `Enter did not create exactly one block: ${JSON.stringify({ before, after })}`,
    );
  }
  const id = fresh[0];

  const deadline = Date.now() + 20_000;
  for (;;) {
    if ((await fetchRows(pageId)).has(id)) break;
    if (Date.now() > deadline)
      throw new Error(`block ${id} never reached the server`);
    await page.waitForTimeout(250);
  }
  // The row is confirmed, so doc-init is unblocked; give its round trip a beat
  // before the first keystroke.
  await page.waitForTimeout(800);
  return id;
}

/**
 * Extend the selection leftwards until it covers exactly the last `n` characters,
 * returning what it ended up covering.
 *
 * A loop rather than `n` presses: a mark boundary owns a virtual stop that can
 * absorb a press, and whether it does is `mark-boundary-verify.ts`'s claim, not
 * this file's. The caller asserts the returned string, so a selection that never
 * reached the target fails LOUDLY here instead of silently formatting the wrong
 * span two assertions later.
 */
async function selectLastChars(page: Page, n: number): Promise<string> {
  for (let guard = 0; guard <= n + 4; guard++) {
    const sel = await selectedText(page);
    if (sel.length === n) return sel;
    await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForTimeout(60);
  }
  return selectedText(page);
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });

  // The scratch page is created through the shared blank-page flow, so it carries
  // the harness's origin header (`agent`): the agent-origin plugin
  // segregates it out of the user's tree and sweeps it after 24h.
  const { pageUrl, pageId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);
  console.log("PAGE_ID:", pageId);

  const ids: Record<string, string> = {};

  for (const { mark, press } of MARKS) {
    // --- Phase 1: the collapsed caret arms the NEXT character ---------------
    //
    // Lexical's collapsed branch of `formatText` is a pure selection toggle, so
    // there is nothing to see until something is typed. The `aa` before the
    // shortcut is half the assertion: it must come back UNMARKED, or the
    // shortcut reached further than the caret.
    {
      const id = await newBlock(page, pageId);
      ids[`${mark}-caret`] = id;
      await page.keyboard.type("aa", { delay: 25 });
      await page.waitForTimeout(KEYSTROKE_MS);
      await page.keyboard.press(press);
      await page.waitForTimeout(ARM_MS);
      await page.keyboard.type("b", { delay: 25 });
      r.eq(
        `P1 ${mark}: a collapsed caret arms the next character`,
        await settledRuns(page, pageId, id),
        [
          { text: "aa", marks: [] },
          { text: "b", marks: [mark] },
        ],
      );
    }

    // --- Phase 2: a range takes the mark ------------------------------------
    {
      const id = await newBlock(page, pageId);
      ids[`${mark}-range`] = id;
      await page.keyboard.type("hello", { delay: 25 });
      await page.waitForTimeout(KEYSTROKE_MS);
      r.eq(
        `P2 ${mark}: the range to format is selected`,
        await selectLastChars(page, 5),
        "hello",
      );
      await page.keyboard.press(press);
      r.eq(
        `P2 ${mark}: the selected run takes the mark`,
        await settledRuns(page, pageId, id),
        [{ text: "hello", marks: [mark] }],
      );
    }

    // --- Phase 3: pressing it again takes the mark back off -----------------
    //
    // Read the phase-2/3 note in the header before touching either: this one is
    // not a redundant restatement of 2, and 2 is not a redundant restatement of
    // this one.
    {
      const id = await newBlock(page, pageId);
      ids[`${mark}-toggle`] = id;
      await page.keyboard.type("hello", { delay: 25 });
      await page.waitForTimeout(KEYSTROKE_MS);
      r.eq(
        `P3 ${mark}: the range to format is selected`,
        await selectLastChars(page, 5),
        "hello",
      );
      await page.keyboard.press(press);
      await page.waitForTimeout(KEYSTROKE_MS);
      await page.keyboard.press(press);
      r.eq(
        `P3 ${mark}: a second press takes the mark back off`,
        await settledRuns(page, pageId, id),
        [{ text: "hello", marks: [] }],
      );
    }
  }

  await snap(page, out, "1-marks-applied");

  // --- Phase 4: ⌘K still opens the link popover -------------------------------
  //
  // The same handler owns ⌘K, and it is the one branch that is NOT a mark: it
  // dispatches `OPEN_LINK_POPOVER_COMMAND` and stops the event so the window-level
  // command palette does not also claim the key. A collapsed caret has no toolbar
  // and so no popover to open (a clean no-op by design), which is why this phase
  // selects first.
  {
    const id = await newBlock(page, pageId);
    ids["link"] = id;
    await page.keyboard.type("linkme", { delay: 25 });
    await page.waitForTimeout(KEYSTROKE_MS);
    r.eq(
      "P4 the range that opens the popover is selected",
      await selectLastChars(page, 6),
      "linkme",
    );
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByPlaceholder("Paste or type a link").first();
    let opened = false;
    for (let guard = 0; guard < 25; guard++) {
      if (await input.isVisible()) {
        opened = true;
        break;
      }
      await page.waitForTimeout(200);
    }
    await snap(page, out, "4-link-popover");
    r.ok("P4 ⌘K opens the link popover", opened);
    if (opened) await page.keyboard.press("Escape");
  }

  console.log("PAGE_URL:", pageUrl);
  console.log("BLOCK_IDS:", JSON.stringify(ids));

  await r.finish();
});
