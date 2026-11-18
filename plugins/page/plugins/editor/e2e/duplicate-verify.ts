// Duplicate is a `BlockOp` — verified in a real browser.
// See research/2026-07-30-page-record-bulkduplicate-on-the-undo-stack.md
//
// The defect: `bulkDuplicate` was the LAST editor mutation reachable from
// `useBlockEditor()` that put nothing on the shared undo stack, because it minted
// its row ids server-side (`POST /blocks/bulk-duplicate`) and so had no
// client-computed after-state to invert. Cmd+Z after the selection bar's
// Duplicate button (or Cmd+D) therefore consumed an OLDER history entry while the
// clones stayed behind. Same root cause, second symptom: no optimistic overlay, so
// a large selection showed nothing until the round-trip AND the push landed.
//
// The fix makes duplicate a `{ kind: "duplicate", placements }` op routed through
// `dispatchOp` — the one path that records an undo entry and builds an overlay —
// with ids minted client-side, exactly as paste does. Phases:
//   A. Cmd+D on ONE selected block: exactly one clone, immediately after its source
//   B. a multi-root selection including a parent with a child: each root's whole
//      SUBTREE is cloned, and each clone lands right after its own source
//   C. Cmd+Z removes exactly the clones and nothing else — the reported symptom's
//      inverse, which is why A's clone is still on the stack underneath: if undo
//      reaches for the wrong entry, A's clone vanishes and B's survive
//   D. Cmd+Shift+Z restores them (an undo whose redo cannot land is half a fix)
//   E. optimism: with the op endpoint stalled 4s, the clones render long before
//      the server could answer, ONE op POST covers the whole multi-root gesture,
//      and the confirming push neither duplicates nor drops them
//
// Usage: bun plugins/page/plugins/editor/e2e/duplicate-verify.ts [--url <deploy>]
import {
  report,
  stallRoute,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  blockTexts as readBlockTexts,
  editableBlocks,
  openBlankPage,
} from "./support/blank-page";
import { blockSelectionDriver } from "./support/block-selection";
import { awaitDocument } from "./support/optimistic";

const r = report();

/** How long the server is held before answering the duplicate's op POST (phase E). */
const STALL_MS = 4000;
/** Blocks typed into phase E's fixture, then duplicated as one gesture. */
const N = 8;
/** `BLOCK_INDENT` — one indent level, in px. */
const INDENT = 24;

await withBrowser(async (h) => {
  const { page } = await h.session();
  const { checkSelectionOwnsFocus, enterBlockSelection } = blockSelectionDriver(
    page,
    r,
  );

  const blockTexts = (): Promise<string[]> => readBlockTexts(page);

  // Ids are the only way to tell a clone from its source (they render identical
  // text), and the only way to say "nothing ELSE changed" about an undo.
  const blockIds = (): Promise<string[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-block-id] [data-block-text]")].map(
        (el) =>
          el.closest("[data-block-id]")?.getAttribute("data-block-id") ?? "",
      ),
    );

  // A block's indent depth is rendered as the ROW's own left padding, so the row's
  // rect never moves — its text does. Measure the contenteditable's left edge.
  const contentLeftOf = (i: number): Promise<number> =>
    page.evaluate((n) => {
      const editables = document.querySelectorAll(
        "[data-block-id] [data-block-text]",
      );
      return editables[n]?.getBoundingClientRect().left ?? -1;
    }, i);

  // ---- Fixture: alpha / bravo(indented under alpha) / charlie / delta --------
  await openBlankPage(page, { settleMs: 3000 });

  for (const word of ["alpha", "bravo", "charlie", "delta"]) {
    await page.keyboard.type(word);
    // Settle either side of the Enter — see copy-paste-verify.ts for why a
    // keystroke landing within ~20ms of a split can be dropped. 250ms rather
    // than that script's 150: every assertion here reads the FULL text array, so
    // one lost leading character ("ravo") fails phases it has nothing to do with.
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }
  // Leave the trailing empty block; wait out the doc→data.text projection (~1s).
  await page.waitForTimeout(2000);

  r.eq("setup: four typed blocks", await blockTexts(), [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "",
  ]);

  // Tab in a block's text editor is the one-element case of the indent op, so
  // this gives phase B a real parent-with-a-child to clone as a subtree.
  const flushLeft = await contentLeftOf(1);
  await editableBlocks(page).nth(1).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(1200);
  r.eq(
    "setup: bravo is indented under alpha",
    (await contentLeftOf(1)) - flushLeft,
    INDENT,
  );

  // ---- A: Cmd+D on a single selected block -----------------------------------
  const idsBeforeA = await blockIds();
  await enterBlockSelection("A", 3); // "delta", nothing extended
  await checkSelectionOwnsFocus("A (duplicate)");
  await page.keyboard.press("Meta+d");
  await page.waitForTimeout(2000); // op POST + confirming push

  r.eq("A: one clone lands immediately after its source", await blockTexts(), [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "delta",
    "",
  ]);
  const idsAfterA = await blockIds();
  const fresh = idsAfterA.filter((id) => !idsBeforeA.includes(id));
  r.eq("A: exactly one NEW block id was minted", fresh.length, 1);
  r.eq(
    "A: and it sits right after the source",
    idsAfterA.indexOf(fresh[0] ?? ""),
    4,
  );

  // ---- B: a multi-root selection, one root of which has a child --------------
  // alpha (+ its child bravo) and charlie are the two selection ROOTS; bravo is a
  // descendant, so it is cloned as part of alpha's subtree, not as a root of its
  // own. Each clone lands after ITS OWN source, so the two placements interleave
  // with the untouched rows rather than piling up at one anchor.
  await enterBlockSelection("B", 0, "Shift+ArrowDown", "Shift+ArrowDown");
  await checkSelectionOwnsFocus("B (duplicate)");
  await page.keyboard.press("Meta+d");
  await page.waitForTimeout(2000);

  const textsB = await blockTexts();
  r.eq("B: each root's subtree is cloned right after that root", textsB, [
    "alpha",
    "bravo",
    "alpha",
    "bravo",
    "charlie",
    "charlie",
    "delta",
    "delta",
    "",
  ]);
  r.eq(
    "B: the cloned child kept its depth under the cloned parent",
    (await contentLeftOf(3)) - (await contentLeftOf(2)),
    INDENT,
  );
  r.eq(
    "B: the cloned parent is itself top-level",
    await contentLeftOf(2),
    await contentLeftOf(0),
  );
  const idsAfterB = await blockIds();
  r.eq(
    "B: three fresh ids (alpha' + bravo' + charlie'), none reused",
    idsAfterB.filter((id) => !idsAfterA.includes(id)).length,
    3,
  );

  // ---- C: Cmd+Z removes exactly B's clones, and nothing else -----------------
  // The reported symptom's exact inverse. A's clone is the previous entry on the
  // stack: if undo consumes the wrong one, "delta delta" collapses back to
  // "delta" while B's clones stay — which is what the unfixed build did. Compare
  // IDS, not just text: it is the only way to assert nothing else moved.
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(2000); // patch POST + push round-trip
  r.eq(
    "C: Cmd+Z removes exactly the duplicated blocks",
    await blockIds(),
    idsAfterA,
  );
  r.eq("C: ... and the earlier duplicate is untouched", await blockTexts(), [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "delta",
    "",
  ]);

  // ---- D: Cmd+Shift+Z puts them back -----------------------------------------
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(2000);
  r.eq("D: Cmd+Shift+Z restores the clones", await blockTexts(), textsB);
  r.eq(
    "D: ... with the same ids the forward op minted",
    await blockIds(),
    idsAfterB,
  );

  // ---- E: optimism, on a fresh page ------------------------------------------
  // Latency alone is a weak assertion — on a fast localhost a round-trip can beat
  // a slow poll. So stall the op endpoint and assert the clones are on screen well
  // before the server could possibly have answered. Only a genuine optimistic
  // overlay passes.
  await openBlankPage(page, { settleMs: 3000 });

  for (let i = 0; i < N; i++) {
    await page.keyboard.type(`line ${String(i).padStart(2, "0")}`);
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000); // doc -> data.text projection

  r.eq("E setup: the fixture typed cleanly", (await blockTexts()).slice(0, 3), [
    "line 00",
    "line 01",
    "line 02",
  ]);

  // Cmd+A selects EVERY block — the N typed ones plus the trailing empty — so the
  // gesture carries N+1 placements. That is the multi-root case the "one op per
  // gesture" claim is really about.
  await enterBlockSelection("E", 0);
  await page.keyboard.press("Meta+a");
  await page.waitForTimeout(200);
  await checkSelectionOwnsFocus("E (duplicate)");

  // Only the structural-op POST is held. Everything else (live-state WS, doc
  // sync) keeps flowing, so this isolates "did the UI wait for the server".
  // `stallRoute` holds the FIRST match only and never unroutes — see its doc
  // comment for why the hand-rolled route-then-unroute shape goes green without
  // exercising the server.
  const opRoute = await stallRoute(page, "**/api/pages/*/blocks/op", {
    ms: STALL_MS,
  });

  const before = await blockTexts();
  // Duplicating EVERY block doubles each row in place — the clone lands after its
  // own source, never in a block at the end. Written as a transform of `before`
  // so the expectation cannot drift from the fixture.
  const doubled = before.flatMap((t) => [t, t]);

  const t0 = Date.now();
  await page.keyboard.press("Meta+d");

  // Two separate milestones, because they answer two separate questions and a
  // clone's ROW lands a beat before its TEXT does: the row comes from the
  // structural overlay, the text from the clone's content doc pre-applying its
  // `data.text` seed once its editor mounts. Both must beat the server, or the
  // "optimistic" claim only covers empty boxes. `awaitDocument` states that rule
  // once (see ./support/optimistic.ts) — the deadline is the bound, so reaching
  // a milestone at all carries the timing claim.
  const {
    rowsAt,
    textAt,
    last: optimistic,
  } = await awaitDocument(page, blockTexts, {
    grewBeyond: before.length,
    expected: doubled,
    timeoutMs: STALL_MS / 2,
    startedAt: t0,
  });

  r.ok(
    `E: clone rows rendered before the server answered (${rowsAt}ms vs a ${STALL_MS}ms stall)`,
    rowsAt >= 0,
  );
  r.ok(
    `E: clone TEXT rendered before the server answered (${textAt}ms vs a ${STALL_MS}ms stall)`,
    textAt >= 0,
  );
  r.eq("E: the whole gesture was ONE op POST", opRoute.count, 1);
  r.eq("E: the optimistic rows are the doubled document", optimistic, doubled);

  // ---- Let the server catch up; the push must CONFIRM, not duplicate ---------
  await page.waitForTimeout(STALL_MS + 3000);
  r.eq(
    "E: the confirming push neither duplicates nor drops the clones",
    await blockTexts(),
    doubled,
  );
  r.eq("E: still exactly one op POST after the push", opRoute.count, 1);

  // A reload proves the rows really persisted with the client-minted ids — the
  // one assertion the never-revert overlay cannot fake. Wait for a block to
  // MOUNT rather than for a fixed delay: a blind timeout reads an empty document
  // whenever hydration is a beat slow, which fails as loudly as a lost clone.
  await page.reload({ waitUntil: "domcontentloaded" });
  await editableBlocks(page)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000); // let the rest of the forest paint
  r.eq("E: the clones survive a reload", await blockTexts(), doubled);

  await r.finish();
});
