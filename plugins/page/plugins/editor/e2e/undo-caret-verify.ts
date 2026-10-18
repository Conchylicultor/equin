// Where the caret lands on a text undo/redo: at the END of what the replay
// changed (`changedSpanEnd`), never at an offset read while typing.
//
// The reported bug: delete a selection mid-line (`xxxx[text deleted]yyyy`),
// Cmd+Z — the text came back but the caret sat at either end of it depending on
// what was typed before (the previous run's end, or the cut). Expected
// `xxxxtext deleted|yyyy`.
//
// Phases:
//  1. type, pause, select-delete mid-line, Cmd+Z: caret after the restored text;
//     Cmd+Shift+Z: caret back at the cut;
//  2. the same with the caret moved to the line's end before Cmd+Z (it must not
//     matter where the caret stood when the entry was recorded or replayed);
//  3. typing undo: caret where the typed text began; redo: after it.
//
// Usage: ./singularity run plugins/page/plugins/editor/e2e/undo-caret-verify.ts [--out /tmp/undo-caret]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockText, openBlankPage } from "./support/blank-page";
import { caretLinear, pressUntilOffset } from "./support/caret";

const out = arg("out", "/tmp/undo-caret");
const r = report();

/** Past the 500 ms idle window that closes a typing run. */
const RUN_CLOSE_MS = 900;

/** Extend the selection `n` units left, at the cadence Lexical absorbs. */
async function selectBack(page: Page, n: number): Promise<void> {
  await page.keyboard.down("Shift");
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(60);
  }
  await page.keyboard.up("Shift");
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const { block } = await openBlankPage(page, { settleMs: 2000 });

  const LINE = "xxxxtext deletedyyyy";
  const CUT = 4;
  const RESTORED_END = "xxxxtext deleted".length;

  await page.keyboard.type(LINE);
  await page.waitForTimeout(RUN_CLOSE_MS);

  // Phase 1 — delete a mid-line selection, undo, redo.
  await page.keyboard.press("Home");
  await pressUntilOffset(page, RESTORED_END);
  await selectBack(page, RESTORED_END - CUT);
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  r.ok("P1 selected", selected === "text deleted", `selection=${JSON.stringify(selected)}`);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(RUN_CLOSE_MS);
  r.ok("P1 deleted", (await blockText(block)) === "xxxxyyyy", await blockText(block));

  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  r.ok("P1 undo restores", (await blockText(block)) === LINE, await blockText(block));
  const afterUndo = await caretLinear(page);
  r.ok("P1 undo caret after restored text", afterUndo === RESTORED_END, `caret=${afterUndo}`);
  await snap(page, out, "p1-undo");

  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(400);
  r.ok("P1 redo deletes", (await blockText(block)) === "xxxxyyyy", await blockText(block));
  const afterRedo = await caretLinear(page);
  r.ok("P1 redo caret at the cut", afterRedo === CUT, `caret=${afterRedo}`);

  // Phase 2 — caret elsewhere when Cmd+Z fires.
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  r.ok("P2 undo restores", (await blockText(block)) === LINE, await blockText(block));
  const p2 = await caretLinear(page);
  r.ok("P2 undo caret after restored text", p2 === RESTORED_END, `caret=${p2}`);

  // Phase 3 — typing mid-line, undo and redo.
  await page.waitForTimeout(RUN_CLOSE_MS);
  await page.keyboard.press("Home");
  await pressUntilOffset(page, CUT);
  await page.keyboard.type("ZZ");
  await page.waitForTimeout(RUN_CLOSE_MS);
  await page.keyboard.press("End");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  r.ok("P3 undo typing", (await blockText(block)) === LINE, await blockText(block));
  const p3u = await caretLinear(page);
  r.ok("P3 undo caret where typing began", p3u === CUT, `caret=${p3u}`);
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(400);
  const p3r = await caretLinear(page);
  r.ok("P3 redo caret after typed text", p3r === CUT + 2, `caret=${p3r}`);

  await r.finish();
});
