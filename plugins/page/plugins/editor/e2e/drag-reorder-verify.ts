// Drag-to-reorder is OPTIMISTIC and lands in AUTHORITATIVE rows — single block
// and multi-selection, in a real browser.
// See research/2026-08-01-page-structural-write-contract.md (Stage 4a).
//
// `move` / `bulkMove` were fire-and-forget POSTs to bespoke endpoints, outside
// the overlay and outside the page's write order — their eslint-disables read
// *"drag again to fix"*, which is what a user had to do whenever a drag raced a
// keystroke. They are now `BlockOp`s, so a drag renders instantly and takes its
// place in the stream like every other structural edit.
//
// Phases:
//   A. drag ONE block down: it lands where it was dropped, in server truth
//   B. move a MULTI-SELECTION (Alt+Shift+Arrow): the run moves as one rigid
//      body, order preserved, in server truth
//   C. Cmd+Z / Cmd+Shift+Z: each gesture is ONE undo entry, and its inverse lands
//   D. optimism: with the op endpoint stalled 4s the reorder is on screen long
//      before the server could answer, from ONE op POST, and the confirming push
//      neither duplicates nor reverts it
//   E. DRAG a multi-selection by the gutter handle: the press does not cost the
//      selection, the run moves as one rigid body from ONE op POST, the selection
//      survives its own drop, and one Cmd+Z reverses the whole thing
//
// B and E pin the SAME op (`bulkMove`) through its two entry points — the
// KEYBOARD nudge and a real DRAG — separately and on purpose, because they fail
// independently. Only the drag has to carry a live block selection past a
// mousedown on a <button>: block-selection mode is focus-scoped, so until the
// rail suppressed the press's default, that mousedown moved focus off the
// selection container and `onFocusCapture` cleared the selection before dnd-kit
// had travelled its 4px activation distance (measured: count 2 -> 2 on hover ->
// 0 on mouse-down). `onDragStart` then saw an empty selection and every
// multi-block drag silently degraded to a single-block `move`.
//
// Usage: bun plugins/page/plugins/editor/e2e/drag-reorder-verify.ts [--url <deploy>] [--headed]
import {
  pageFetch,
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

/** How long the server is held before answering the drag's op POST (phase D). */
const STALL_MS = 4000;
/** Steps the pointer takes between grab and drop — dnd-kit needs real movement. */
const DRAG_STEPS = 12;

await withBrowser(async (h) => {
  const { page } = await h.session();
  const { checkSelectionOwnsFocus, enterBlockSelection, selectedCount } =
    blockSelectionDriver(page, r);

  const blockTexts = (): Promise<string[]> => readBlockTexts(page);

  /** The page's rows as the SERVER holds them, in document (rank) order. */
  const serverTexts = async (id: string): Promise<string[]> => {
    const res = await pageFetch(page, `/api/pages/${id}/blocks`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET blocks -> ${res.status}`);
    const rows = (await res.json()) as {
      rank: string;
      data: { text?: unknown };
    }[];
    const plain = (text: unknown): string => {
      if (typeof text === "string") return text.trim();
      if (Array.isArray(text)) {
        return text
          .map((run) =>
            typeof run === "object" && run !== null
              ? String((run as { text?: unknown }).text ?? "")
              : "",
          )
          .join("")
          .trim();
      }
      return "";
    };
    return [...rows]
      .sort((x, y) => (String(x.rank) < String(y.rank) ? -1 : 1))
      .map((b) => plain(b.data.text));
  };

  /**
   * Drag the row at `from` onto the row at `to`, dropping in its lower half so
   * the editor resolves an "after" zone. The handle only becomes hoverable once
   * its row is hovered (the gutter controls are `pointer-events-none` at rest),
   * so the pointer moves onto the row first.
   *
   * `afterGrab` runs INSIDE the gesture — after the press, before the pointer
   * has travelled dnd-kit's 4px activation distance. That window is the only
   * place an assertion about what the PRESS did can land: everything the
   * mousedown did to focus has already happened, and the drag has not yet
   * started, so nothing can have masked it. The same reading taken after the
   * drop is a composite of press + drag + drop — it could not say which of the
   * three lost what it measures, and a drop that re-derived the state would hide
   * the press entirely.
   */
  const dragRow = async (
    from: number,
    to: number,
    afterGrab?: () => Promise<void>,
  ): Promise<number> => {
    const rowBox = async (i: number) => {
      const box = await page.locator("[data-block-id]").nth(i).boundingBox();
      if (!box) throw new Error(`row ${i} has no box`);
      return box;
    };
    const src = await rowBox(from);
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.waitForTimeout(200);

    const handle = page
      .locator("[data-block-id]")
      .nth(from)
      .getByLabel("Reorder or open block actions");
    const hb = await handle.boundingBox();
    if (!hb) throw new Error(`row ${from} has no drag handle`);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    if (afterGrab) await afterGrab();
    // PointerSensor needs >4px before the drag starts at all.
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 8, {
      steps: 3,
    });

    const dst = await rowBox(to);
    const dropY = dst.y + dst.height * 0.75; // lower half ⇒ "after"
    await page.mouse.move(hb.x + hb.width / 2, dropY, { steps: DRAG_STEPS });
    await page.waitForTimeout(200);
    await page.mouse.up();
    // The drop instant, NOT the grab: the gesture itself takes ~2s of scripted
    // pointer movement, and timing the optimism from before it would measure the
    // script rather than the overlay.
    return Date.now();
  };

  // ---- Fixture: alpha / bravo / charlie / delta ------------------------------
  const { pageId } = await openBlankPage(page, { settleMs: 3000 });
  for (const word of ["alpha", "bravo", "charlie", "delta"]) {
    await page.keyboard.type(word);
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000); // the doc→data.text projection (~1s)
  r.eq("setup: four typed blocks", await blockTexts(), [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "",
  ]);

  // ---- A: one block ----------------------------------------------------------
  await dragRow(0, 2); // alpha, dropped after charlie
  await page.waitForTimeout(2500);
  const afterA = ["bravo", "charlie", "alpha", "delta", ""];
  r.eq(
    "A: the dragged block landed after its drop target",
    await blockTexts(),
    afterA,
  );
  r.eq(
    "A: ... and in AUTHORITATIVE rows, not just the overlay",
    await serverTexts(pageId),
    afterA,
  );

  // ---- B: a multi-selection --------------------------------------------------
  // bravo + charlie as one run, nudged below alpha. The selection must move as a
  // rigid body: its internal order survives and nothing else re-ranks — the
  // `bulkMove` op's whole contract.
  await enterBlockSelection("B", 0, "Shift+ArrowDown");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.waitForTimeout(2500);
  const afterB = ["alpha", "bravo", "charlie", "delta", ""];
  r.eq(
    "B: the selection moved as one body, order preserved",
    await blockTexts(),
    afterB,
  );
  r.eq("B: ... in AUTHORITATIVE rows", await serverTexts(pageId), afterB);

  // ---- C: one gesture is ONE undo entry --------------------------------------
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(2500);
  r.eq(
    "C: Cmd+Z reverses the whole multi-block move at once",
    await blockTexts(),
    afterA,
  );
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(2500);
  r.eq("C: Cmd+Shift+Z replays it", await blockTexts(), afterB);
  r.eq(
    "C: ... and server truth followed the redo",
    await serverTexts(pageId),
    afterB,
  );

  // ---- D: optimism, on a fresh page ------------------------------------------
  // Latency alone proves nothing on a fast localhost, so stall the op endpoint
  // and assert the reorder is on screen well before the server could answer.
  // Only a genuine optimistic overlay passes — this is the behaviour change the
  // two `drag again to fix` disables used to deny.
  const fresh = await openBlankPage(page, { settleMs: 3000 });
  for (const word of ["one", "two", "three"]) {
    await page.keyboard.type(word);
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000);

  const opRoute = await stallRoute(page, "**/api/pages/*/blocks/op", {
    ms: STALL_MS,
  });
  const t0 = await dragRow(0, 1); // "one" after "two"; the clock starts at the DROP
  const want = ["two", "one", "three", ""];

  // A reorder moves rows that are already mounted and hydrated, so it has ONE
  // milestone, not the structure-then-text pair a paste/duplicate has — hence no
  // `grewBeyond`. The wait's predicate is the asserted document either way.
  const { textAt: renderedAt } = await awaitDocument(page, blockTexts, {
    expected: want,
    timeoutMs: STALL_MS / 2,
    startedAt: t0,
  });
  r.ok(
    `D: the reorder rendered before the server answered (${renderedAt}ms vs a ${STALL_MS}ms stall)`,
    renderedAt >= 0,
  );
  r.eq("D: the whole drag was ONE op POST", opRoute.count, 1);

  await page.waitForTimeout(STALL_MS + 3000);
  r.eq(
    "D: the confirming push neither reverts nor duplicates it",
    await blockTexts(),
    want,
  );
  r.eq("D: ... and server truth agrees", await serverTexts(fresh.pageId), want);
  r.eq("D: still exactly one op POST after the push", opRoute.count, 1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await editableBlocks(page)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);
  r.eq("D: the reorder survives a reload", await blockTexts(), want);

  // ---- E: DRAGGING a multi-selection -----------------------------------------
  // The other entry point to phase B's op, and the only one that has to keep a
  // block selection alive across a mousedown on the gutter handle's <button>.
  //
  // On its OWN fresh page: D ends in a reload, and a phase reading order out of
  // whatever A-D left behind would be a spec about the script rather than about
  // the editor.
  const multi = await openBlankPage(page, { settleMs: 3000 });
  for (const word of [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
  ]) {
    await page.keyboard.type(word);
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000); // the doc→data.text projection (~1s)
  const beforeE = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", ""];
  r.eq(
    "E: setup: six typed blocks on a fresh page",
    await blockTexts(),
    beforeE,
  );

  // charlie + delta. The run starts at row 2 rather than at the top of the
  // document because a LIVE selection bar is pinned over the first ~46px of the
  // block list, horizontally centred: `dragRow` hovers a row at its centre to
  // reveal the gutter controls, and over rows 0-1 that centre lands on the bar
  // instead of on the row.
  await enterBlockSelection("E", 2, "Shift+ArrowDown");
  r.eq(
    "E: the gesture starts from a two-block selection",
    await selectedCount(),
    2,
  );

  // Count this gesture's writes. `stallRoute` is the harness's only request
  // observer and there is no count-only variant; `times: 0` stalls nothing, so
  // this is that counter with the stall turned off. Registered AFTER the seed, so
  // the typing's own splits are not in the tally, and last, so it — not phase D's
  // long-spent route on the same pattern — is the handler that answers.
  const opsE = await stallRoute(page, "**/api/pages/*/blocks/op", {
    ms: 0,
    times: 0,
  });

  // Grab charlie's handle (row 2, a member of the selection) and drop into
  // foxtrot's lower half.
  await dragRow(2, 5, async () => {
    r.eq(
      "E: the PRESS on the drag handle costs nothing of the selection",
      await selectedCount(),
      2,
    );
  });
  await page.waitForTimeout(2500);

  // `bulkMove({ ids: [charlie, delta], parentId: <the page's top level>,
  // afterId: foxtrot })`. The lower half of foxtrot's row is its "after" zone, so
  // `onDragEnd`'s bulk arm resolves `afterId` to foxtrot itself; `planBulkMove`
  // takes the selection ROOTS in document order, excludes the moving subtree from
  // the insertion window so the run cannot bound itself, and mints two ranks in
  // the window (foxtrot, trailing-empty-block) — one per root, in that order. So
  // charlie and delta land contiguous and in their own order between foxtrot and
  // the trailing empty block, and every other row keeps the rank it had.
  const afterE = ["alpha", "bravo", "echo", "foxtrot", "charlie", "delta", ""];
  r.eq(
    "E: the dragged selection moved as ONE rigid body, internal order intact",
    await blockTexts(),
    afterE,
  );
  r.eq(
    "E: ... nothing else re-ranked, and in AUTHORITATIVE rows",
    await serverTexts(multi.pageId),
    afterE,
  );
  r.eq("E: the whole drag was ONE op POST", opsE.count, 1);

  // The fix restated as an observable rather than inferred from the outcome: the
  // selection container held focus for the entire gesture, so the selection it
  // owns is still there to act on afterwards.
  r.eq("E: the selection survives its own drop", await selectedCount(), 2);
  await checkSelectionOwnsFocus("E (after the drop)");

  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(2500);
  r.eq(
    "E: one Cmd+Z reverses the whole multi-block drag",
    await blockTexts(),
    beforeE,
  );

  await r.finish();
});
