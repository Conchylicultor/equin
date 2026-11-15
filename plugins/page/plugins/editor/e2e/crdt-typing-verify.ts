// Stage-2 per-block CRDT verification (research/2026-07-07-page-per-block-crdt-plan-b.md).
//
// With per-block CRDT text (now unconditional — the flag is deleted):
//  1. create a blank page, focus its empty text block;
//  2. type a multi-word string FAST, in bursts, so debounced doc-update flushes
//     and their live-state echoes land MID-typing (the exact trigger of the old
//     "Generalization of Notion" → "Generationlization of No" scramble);
//  3. assert the final text is exactly what was typed and the caret sat at the
//     very end the whole time;
//  4. open the same page in a SECOND browser context and assert it converges to
//     the same text (server round-trip through doc-update → page_block_docs →
//     the blockDocs row).
//
// Usage: bun plugins/page/plugins/editor/e2e/crdt-typing-verify.ts [--url <deploy>] [--out /tmp/crdt]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  ELEMENT_TIMEOUT_MS,
  waitFor,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { blockText, caretState, openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/crdt");
const r = report();

const TYPED = "Generalization of Notion via per-block CRDT typing";

await withBrowser(async (h) => {
  const { page: pageA } = await h.session({ label: "A" });

  // Create a fresh blank page from the landing quick-create tile; the blank page
  // ships one empty text block, already focused.
  const doc = await openBlankPage(pageA, { settleMs: 3000 });
  const pageUrl = doc.pageUrl;
  console.log("page url:", pageUrl);

  const block = doc.block;
  const blockId = doc.blockId;
  console.log("block id:", blockId);
  await snap(pageA, out, "before");

  // Type in fast bursts with pauses > the 300ms flush debounce, so the echo of
  // each flushed doc-update lands WHILE the next burst is being typed.
  const words = TYPED.split(" ");
  const bursts = [
    words.slice(0, 2),
    words.slice(2, 4),
    words.slice(4, 6),
    words.slice(6),
  ];
  for (const [i, burst] of bursts.entries()) {
    const chunk = (i === 0 ? "" : " ") + burst.join(" ");
    await pageA.keyboard.type(chunk, { delay: 8 }); // ~125 chars/s — fast typing
    await pageA.waitForTimeout(450); // let the debounced flush + live echo land mid-run
  }
  // A FIXED settle, deliberately, and it must not become a condition wait.
  // "Wait until the text is right" is wrong wherever the defect is a state the
  // app passes THROUGH: the scramble this script exists to catch
  // ("Generalization of Notion" -> "Generationlization of No") is transient, so
  // a poll would wait it out and report the run green ON the bug. Settle once,
  // read once, assert on that read.
  await pageA.waitForTimeout(1500);

  const gotA = await blockText(block);
  const caret = await caretState(block);
  await snap(pageA, out, "after");

  console.log("typed   :", JSON.stringify(TYPED));
  console.log("observed:", JSON.stringify(gotA));
  console.log("caret   :", JSON.stringify(caret));
  const textOk = gotA === TYPED;
  const caretOk = Boolean(
    caret.hasSelection &&
    caret.collapsed &&
    caret.insideBlock &&
    caret.anchorOffset === caret.anchorTextLength &&
    caret.anchorTextLength === TYPED.length,
  );
  r.ok("TEXT — exact match", textOk, `observed ${JSON.stringify(gotA)}`);
  r.ok("CARET — collapsed at end of the typed text", caretOk);

  // --- Convergence: a second, fresh browser context (own socket, cold load) ----
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl);
  const blockB = pageB
    .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
    .first();
  await blockB.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  // Was a fixed `waitForTimeout(5000)`. A second context measured 6.2-6.4s to
  // render against main on an IDLE machine, so this read landed before the text
  // arrived and the check below reported a convergence failure that was the
  // clock, not the app. The demand is unchanged — only when it is read.
  const converged = await waitFor(
    () => blockText(blockB),
    (text) => text === TYPED,
  );
  const gotB = converged.value;
  await snap(pageB, out, "context-b");
  console.log(
    "context B observed:",
    JSON.stringify(gotB),
    `(after ${converged.waitedMs}ms, ${converged.attempts} reads)`,
  );
  r.ok(
    "CONVERGENCE — second context matches",
    converged.ok,
    `observed ${JSON.stringify(gotB)}`,
  );

  // --- Concurrent-echo stress: type MORE in A while B is subscribed too --------
  await pageA.bringToFront();
  await block.click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(" — appended after reload", { delay: 8 });
  const FINAL = `${TYPED} — appended after reload`;
  // Same defect as above, one arm later: this was a fixed `waitForTimeout(1800)`
  // before reading BOTH contexts. Waiting on the condition instead.
  const live = await waitFor(
    async () => ({ a: await blockText(block), b: await blockText(blockB) }),
    ({ a, b }) => a === FINAL && b === FINAL,
  );
  const finalA = live.value.a;
  const finalB = live.value.b;
  console.log("final A :", JSON.stringify(finalA));
  console.log("final B :", JSON.stringify(finalB));
  r.ok(
    "LIVE CROSS-CONTEXT — B received A's edit live",
    live.ok,
    `A ${JSON.stringify(finalA)} / B ${JSON.stringify(finalB)}`,
  );

  await r.finish();
});
