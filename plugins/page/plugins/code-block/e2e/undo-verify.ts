// Undo verification for the code block's plain-text surface, in a real browser.
//
// The bug this pins (research/2026-09-01-global-block-text-undo-participation.md):
// pasting inside a `/code` block could not be undone. The textarea declared no
// undo owner, so `resolveUndoOwner` walked up to the page body's
// `surfaceUndoProps` and ⌘Z resolved to the SURFACE stack — the binding called
// `preventDefault()`, killing the browser's own textarea history, while the only
// thing that recorded was a 500ms-debounced autosave. So a ⌘Z pressed in that
// window reversed an unrelated document edit and left the pasted text sitting
// there.
//
// Phase 3 is the reported bug itself: the ⌘Z is sent with NO delay after the
// paste, i.e. inside the old debounce window. Waiting there would let a broken
// build pass.
//
// Phases:
//   1. ``` converts a text block into a code block with a live textarea;
//   2. a typing run is one undo step;
//   3. a paste is its own undo step, undoable IMMEDIATELY (the reported bug);
//   4. redo replays the paste, then a second ⌘Z walks back to the typing;
//   5. undo past the block's own text reaches the structural stack, so the
//      document history stays one chronological stack rather than two.
//
// Usage: ./equin run plugins/page/plugins/code-block/e2e/undo-verify.ts [--url <deploy>]
import {
  ELEMENT_TIMEOUT_MS,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/code-undo");
const r = report();

const TYPED = "const x = 1";
// Deliberately free of `${…}`: a plain string carrying a template-literal
// placeholder trips the global `no-template-curly-in-string` rule, and the
// snippet's job here is only to be multi-line and unmistakable.
const PASTED = ["function greet(name) {", '  return "hi " + name;', "}"].join(
  "\n",
);

// Longer than the undo stack's DEFAULT_COALESCE_WINDOW_MS (500ms), so the run
// before it is closed and the next edit starts its own entry. Used ONLY to
// separate two deliberate steps — never before a ⌘Z, which is the thing under
// test.
const PAST_COALESCE_MS = 700;

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await openBlankPage(page, { settleMs: 3000 });

  // ---- 1: ``` converts the empty text block into a code block ---------------
  await page.keyboard.type("```");
  const ta = page.locator("[data-block-id] textarea").first();
  await ta.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  r.ok("1: ``` produced a code block with an editable textarea", true);

  const value = (): Promise<string> => ta.inputValue();
  // The block owns DOM focus already (`useVoidCaret` focuses it on `isFocused`),
  // but click anyway: a click is what a user does, and it proves the surface is
  // reachable by pointer as well as by the editor's focus model.
  await ta.click();

  // ---- 2: a typing run is ONE undo step ------------------------------------
  await page.keyboard.type(TYPED);
  r.eq("2: typing landed in the textarea", await value(), TYPED);

  await page.waitForTimeout(PAST_COALESCE_MS);

  // ---- 3: a paste is its own step, undoable with NO delay -------------------
  await page.evaluate((text) => navigator.clipboard.writeText(text), PASTED);
  await page.keyboard.press("Meta+v");

  // Assert the paste actually landed BEFORE undoing it. Without this the phase
  // below passes vacuously on a build where the paste never arrived.
  const afterPaste = await value();
  r.eq("3a: the paste landed", afterPaste, TYPED + PASTED);

  // THE REPORTED BUG. No wait: this ⌘Z lands inside the window the old
  // debounced autosave had not yet recorded in.
  await page.keyboard.press("Meta+z");
  r.eq(
    "3b: ⌘Z immediately after a paste reverts the paste",
    await value(),
    TYPED,
  );
  await snap(page, out, "after-undo-paste");

  // ---- 4: redo replays the paste; a second ⌘Z reaches the typing -----------
  await page.keyboard.press("Meta+Shift+z");
  r.eq("4a: ⌘⇧Z replays the paste", await value(), TYPED + PASTED);

  await page.keyboard.press("Meta+z");
  r.eq("4b: ⌘Z reverts the paste again", await value(), TYPED);

  await page.keyboard.press("Meta+z");
  r.eq("4c: a second ⌘Z reverts the typing run", await value(), "");

  // ---- 5: the same stack keeps going past the block's own text -------------
  // One chronological history, not an island: once the block's text is undone,
  // the next ⌘Z reaches the structural entry that created the block. If the
  // textarea kept a private history this would stop here instead.
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  r.eq(
    "5: undo continues into the structural stack (the code block is gone)",
    await page.locator("[data-block-id] textarea").count(),
    0,
  );
  await snap(page, out, "after-undo-block");
});

await r.finish();
