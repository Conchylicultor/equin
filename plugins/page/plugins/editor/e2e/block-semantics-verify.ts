// A heading block IS a heading, verified in a real browser.
// See research/2026-08-16-page-block-aria-semantics.md and the editor's
// CLAUDE.md, *A block type declares its ARIA identity*.
//
// What is being defended:
//
//  1. Heading-jump works. A page's `heading-1/2/3` blocks render as ordinary
//     editable lines; a block type declares `semantics` and the shared skeleton
//     turns it into `role="heading"` + `aria-level` on its leaf cell. Three
//     typed headings must therefore be three headings, at their own levels, each
//     NAMED by its own line — and the plain paragraph beside them must be none.
//  2. The role appears without costing the caret. Converting a paragraph into a
//     heading is a re-style of a FIXED element skeleton, never a remount, so the
//     user keeps typing where they were. That is the whole reason the role is an
//     attribute on the leaf cell rather than a real `<h2>` element.
//  3. An empty focused heading is not named by its placeholder. The placeholder
//     renders INSIDE the leaf cell, so without `aria-hidden` an empty H1 would
//     announce as "Heading 1" — named by decoration.
//
// Why a real browser, and not `web/__tests__/block-semantics.test.tsx` alone:
// that test renders the skeleton with a stand-in for the Lexical leaf, so it can
// state what the skeleton does with a declared role but nothing about what
// Lexical's real DOM does to the accessible name, nor about the caret surviving
// a live conversion. Both are only observable here — and the accessible NAME
// specifically, because it is computed by the browser over the real
// `heading` > `textbox` nesting, is the part with no jsdom equivalent.
//
// Usage: bun plugins/page/plugins/editor/e2e/block-semantics-verify.ts [--url <deploy>]
import type { Locator } from "playwright";
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  blockIdOf,
  caretState,
  editableBlocks,
  openBlankPage,
} from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const r = report("block-semantics");

/** The block list itself, so the app's own chrome never counts as a heading. */
const BLOCK_LIST = '[role="group"][aria-label="Page blocks"]';

await withBrowser(async (h) => {
  const { page } = await h.session();

  const blocks = page.locator(BLOCK_LIST);

  /**
   * A count that WAITS for the expected answer instead of sampling once.
   *
   * A bare `count()` after a fixed sleep is a race here, and the placeholder is
   * where it bites: it renders only while the block is empty, and "empty" is
   * read off the row's `text` — a projection of the content doc that lags it by
   * up to a second. So the honest question is "does this settle at N", not
   * "is it N at this instant".
   *
   * Only for expectations of ONE OR MORE. Polling for zero would return the
   * first transient zero and call a state that has not arrived yet a pass, so
   * every `want: 0` below stays a direct `count()` on state the step before it
   * already settled.
   */
  const settlesAt = async (
    locator: Locator,
    want: number,
    timeoutMs = 6000,
  ): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    let seen = await locator.count();
    while (seen !== want && Date.now() < deadline) {
      await page.waitForTimeout(150);
      seen = await locator.count();
    }
    return seen;
  };

  /** Every `role="heading"` inside the document, as (level, text) pairs. */
  const headingRoles = (): Promise<{ level: string | null; text: string }[]> =>
    page.evaluate(
      (scope) =>
        [
          ...(document
            .querySelector(scope)
            ?.querySelectorAll('[role="heading"]') ?? []),
        ].map((el) => ({
          level: el.getAttribute("aria-level"),
          text: (el.textContent ?? "").replace(/ /g, " ").trim(),
        })),
      BLOCK_LIST,
    );

  await openBlankPage(page, { settleMs: 3000 });

  // ---- 1. Three markdown headings become three real headings ----------------
  //
  // Typed, not seeded: the markdown prefix is what a user actually does, and the
  // level must track the prefix (`# ` ⇔ 1) rather than the typography.
  await typeLines(page, ["# H one", "## H two", "### H three", "plain line"]);
  await page.waitForTimeout(1200);

  r.note(`heading roles: ${JSON.stringify(await headingRoles())}`);

  for (const [level, name] of [
    [1, "H one"],
    [2, "H two"],
    [3, "H three"],
  ] as const) {
    r.eq(
      `H${level} is a heading at level ${level} named "${name}"`,
      await settlesAt(
        blocks.getByRole("heading", { level, name, exact: true }),
        1,
      ),
      1,
    );
  }

  // Four lines, three headings: the paragraph declares no `semantics`, so it
  // carries no role at all. This is the half that makes heading-jump USEFUL —
  // a document where everything is a heading is a document with no landmarks.
  r.eq(
    "the block list holds exactly three headings",
    await settlesAt(blocks.getByRole("heading"), 3),
    3,
  );
  r.eq(
    "the plain paragraph is not a heading",
    await blocks
      .getByRole("heading", { name: "plain line", exact: true })
      .count(),
    0,
  );

  // ---- 2. Converting in place gains the role and keeps the caret ------------
  //
  // The fixed-skeleton guarantee: only attributes change, so the live Lexical
  // instance, its binding and the user's caret all survive the conversion.
  await page.keyboard.press("Enter");
  await page.keyboard.type("becomes a heading", { delay: 25 });
  await page.waitForTimeout(400);

  const blockId = await blockIdOf(editableBlocks(page).last());
  const inBlock = `[data-block-id="${blockId}"]`;
  r.note(`conversion target: ${blockId}`);

  r.eq(
    "before the conversion the line is not a heading",
    await page.locator(`${inBlock} [role="heading"]`).count(),
    0,
  );

  // `## ` at line start — the same markdown shortcut, this time on a block that
  // already holds text, so the conversion has a caret to lose.
  await page.keyboard.press("Home");
  await page.keyboard.type("## ", { delay: 25 });
  await page.waitForTimeout(1200);

  r.eq(
    "the same block id is still on screen (no remount)",
    await settlesAt(page.locator(inBlock), 1),
    1,
  );
  r.eq(
    "the converted line now carries role=heading aria-level=2",
    await settlesAt(
      page.locator(`${inBlock} [role="heading"][aria-level="2"]`),
      1,
    ),
    1,
  );
  r.eq(
    "and is named by its own text, prefix stripped",
    await settlesAt(
      blocks.getByRole("heading", {
        level: 2,
        name: "becomes a heading",
        exact: true,
      }),
      1,
    ),
    1,
  );

  const caret = await caretState(
    page.locator(`${inBlock} [data-block-text]`).first(),
  );
  r.note(`caret after the conversion: ${JSON.stringify(caret)}`);
  r.ok(
    "the caret is still collapsed inside the converted block",
    caret.hasSelection === true &&
      caret.collapsed === true &&
      caret.insideBlock === true,
    JSON.stringify(caret),
  );

  // The caret is not merely present — it is live, so the next keystroke lands in
  // this block. Typing is the only honest proof of that. WHERE the character
  // lands is deliberately not pinned here (the strip leaves the caret at the
  // former prefix's position, which `convert-in-place-verify.ts` owns); what is
  // pinned is that exactly one typed character reached THIS heading.
  await page.keyboard.type("X", { delay: 25 });
  await page.waitForTimeout(800);
  const afterTyping = (
    await page.locator(`${inBlock} [role="heading"]`).first().innerText()
  )
    .replace(/ /g, " ")
    .trim();
  r.note(`heading text after typing: ${JSON.stringify(afterTyping)}`);
  r.eq(
    "typing straight after the conversion lands in the same heading",
    afterTyping.replace("X", ""),
    "becomes a heading",
  );

  // ---- 3. An empty focused heading is not named by its placeholder ----------
  //
  // The placeholder sits inside the leaf cell — the element carrying the role —
  // so it is `aria-hidden`. Both halves are asserted: it really is rendered (or
  // the case is vacuous), and it names nothing.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# ", { delay: 25 });
  await page.waitForTimeout(1200);

  const emptyId = await blockIdOf(editableBlocks(page).last());
  const inEmpty = `[data-block-id="${emptyId}"]`;
  r.note(`empty heading: ${emptyId}`);

  r.eq(
    "the empty line converted to a level-1 heading",
    await settlesAt(
      page.locator(`${inEmpty} [role="heading"][aria-level="1"]`),
      1,
    ),
    1,
  );
  r.eq(
    "its placeholder is rendered and hidden from assistive tech",
    await settlesAt(
      page
        .locator(`${inEmpty} [aria-hidden="true"]`)
        .filter({ hasText: "Heading 1" }),
      1,
    ),
    1,
  );
  r.eq(
    "no heading anywhere is named by that placeholder",
    await blocks
      .getByRole("heading", { name: "Heading 1", exact: true })
      .count(),
    0,
  );

  await r.finish();
});
