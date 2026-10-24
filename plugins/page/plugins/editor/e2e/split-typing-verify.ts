// Typing straight through an Enter loses nothing, verified in a real browser.
// See research/2026-07-31-page-caret-authority.md
//
// The defect: `focusNew` could not focus the block it had just minted — it does
// not exist yet — so it armed `pendingFocusRef`, and the caret only landed when
// the new `BlockTextEditor` mounted and its PASSIVE effect registered a focus
// handle. React flushes passive effects in a separate scheduler task, while
// keydown arrives from the browser's higher-priority user-interaction task
// source, so a keystroke in that gap was structurally favoured to win — and it
// was delivered to the ORIGIN's contenteditable, already truncated with the
// caret at the cut point. Each word's FIRST character stayed behind:
//
//   typed:  "alpha" Enter "bravo" Enter "charlie"
//   got:    ["alphab", "ravoc", "harlie"]
//
// The fix makes the editor's own caret the authority: on a split it takes the
// keyboard from the DOM, buffers input while the caret is in flight, and replays
// it into the target once that block can actually hold a caret. Input follows the
// model, not the DOM.
//
// SCOPE: this gate only proves the FAST path — on an idle box the flight window
// is short, so it catches a regression that reopens the gap for ordinary typing,
// not one that merely lengthens a window still narrower than the harness's own
// keystroke cadence. The deterministic long-window case (a handle withheld
// indefinitely, so the flight cannot land at all) is the jsdom test
// `web/__tests__/caret-authority.test.tsx`. Rerunning this under host load (a few
// concurrent `./equin build`s) reproduces the original conditions.
//
// Usage: bun plugins/page/plugins/editor/e2e/split-typing-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockText, editableBlocks, openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const r = report();

const LINES = ["alpha", "bravo", "charlie"];

await withBrowser(async (h) => {
  const { page } = await h.session();

  await openBlankPage(page, { settleMs: 3000 });

  // The repro verbatim: zero `delay`, and nothing settled around either Enter.
  // `typeLines` is where that policy lives — it must stay settle-free for this
  // assertion to mean anything.
  await typeLines(page, LINES);

  // Wait out the ~1s doc -> data.text projection so the read is of settled
  // state. (The symptom is in the DOM immediately; this only rules out reading
  // a doc mid-flush.)
  await page.waitForTimeout(2000);

  const texts = await Promise.all(
    (await editableBlocks(page).all()).map(blockText),
  );

  r.eq("every keystroke landed in the block the Enter created", texts, LINES);

  await r.finish();
});
