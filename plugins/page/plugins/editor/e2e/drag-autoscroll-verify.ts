// Drag-SELECT auto-scrolls at the viewport edge, in a real browser.
//
// Block REORDER (dnd-kit) has always auto-scrolled; drag-select never did. The
// marquee and the promoted cross-block text drag are one hand-rolled pointer
// loop in `block-editor.tsx`'s `onPointerDown`, and nothing in it scrolled
// anything — so on a page longer than the viewport a selection simply stopped at
// the last on-screen block, no matter how long the pointer was held at the edge.
//
// Unfixed baseline (read off the pre-fix source, NOT measured — this spec was
// written alongside the fix, before a build existed to run it against):
//
//   step 1  scroll delta over a 1.5s stationary hold at the edge -> 0px
//   step 2  marquee anchor -> drifts by the FULL scroll distance, because
//           `top = min(start.y, ev.clientY) - contentRect.top` mixes a viewport
//           clientY frozen at pointerdown with a content rect re-read per frame
//           (reachable today by trackpad-scrolling mid-marquee)
//   step 6  upward hold -> 0px
//
// Steps 4 and 5 are the two things the fix must NOT break: native intra-block
// text selection (whose own autoscroll may compound with ours — step 4 measures
// it rather than asserting a guess), and click-to-edit on the trailing empty
// zone, which sits inside the bottom edge band on a full page and would become a
// runaway scroll without the engagement gate.
//
// The pointer is held STATIONARY for every scroll assertion. That is the whole
// point: what advances the gesture is the rAF loop, not the mouse.
//
// Usage: bun plugins/page/plugins/editor/e2e/drag-autoscroll-verify.ts [--url <deploy>] [--headed]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";

const r = report();

/** Lines typed by hand before the doc is doubled by copy/paste. */
const TYPED_LINES = 8;
/** Pastes of the copied 9-block document: 9 + 6×9 = 63 blocks, several viewports. */
const PASTE_ROUNDS = 6;
/** How long the pointer is parked at an edge per measured hold. */
const HOLD_MS = 1500;
/** Distance from the scroller's edge the pointer is parked at (inside the band). */
const EDGE_INSET = 12;

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // ---- Probes ---------------------------------------------------------------

  // MIRRORS the hook's scroller resolution rather than depending on it, so the
  // spec does not encode the implementation: walk up from a block until an
  // ancestor is both style-scrollable and actually overflowing. The edge band is
  // read off the VIEWPORT — for the document scroller that is the window, whose
  // rect is the document's height, not the visible one.
  const probeScroller = () =>
    page.evaluate(() => {
      let n: HTMLElement | null =
        document.querySelector("[data-block-id]")?.parentElement ?? null;
      while (n) {
        const o = getComputedStyle(n).overflowY;
        if (
          (o === "auto" || o === "scroll") &&
          n.scrollHeight > n.clientHeight
        ) {
          const isRoot = n === document.scrollingElement;
          const rect = n.getBoundingClientRect();
          return {
            found: true,
            scrollTop: n.scrollTop,
            maxScroll: n.scrollHeight - n.clientHeight,
            top: isRoot ? 0 : rect.top,
            bottom: isRoot ? window.innerHeight : rect.bottom,
          };
        }
        n = n.parentElement;
      }
      return {
        found: false,
        scrollTop: -1,
        maxScroll: -1,
        top: 0,
        bottom: window.innerHeight,
      };
    });

  const scrollTop = async (): Promise<number> =>
    (await probeScroller()).scrollTop;

  const blockCount = (): Promise<number> =>
    page.evaluate(() => document.querySelectorAll("[data-block-id]").length);

  const selectedCount = (): Promise<number> =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("span")].find((s) =>
        /^\d+ selected$/.test(s.textContent ?? ""),
      );
      const n = el?.textContent?.split(" ")[0];
      return n === undefined ? 0 : Number(n);
    });

  /** A `[data-block-id]` row's live viewport rect — valid while scrolled off-screen. */
  const rowRect = (index: number) =>
    page.evaluate((i) => {
      const el = document.querySelectorAll("[data-block-id]")[i];
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        top: b.top,
        bottom: b.bottom,
        left: b.left,
        right: b.right,
        centerY: b.top + b.height / 2,
      };
    }, index);

  // The marquee rectangle. `.border-primary/40` is unique to it on this surface
  // (the only other use in the repo is a conversation option row) — read off the
  // render in `block-editor.tsx`, not guessed.
  const marqueeTop = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".border-primary\\/40");
      return el === null ? null : el.getBoundingClientRect().top;
    });

  /**
   * The rightmost point at viewport `y` that the editor will classify as a
   * BACKGROUND press: inside the interaction surface, and either the surface
   * itself, a row element itself (a row's gutter rail is its own padding), or
   * something that is not inside a row at all. A hit on a row DESCENDANT that is
   * neither text nor background is explicitly ignored by `onPointerDown`, so
   * landing on one would silently produce no gesture at all.
   */
  const backgroundPointAt = (y: number) =>
    page.evaluate((clientY) => {
      const surface = document.querySelector('[aria-label="Page blocks"]');
      if (!surface) return null;
      const s = surface.getBoundingClientRect();
      for (let x = s.right - 8; x > s.left; x -= 8) {
        const el = document.elementFromPoint(x, clientY);
        if (!el || !surface.contains(el)) continue;
        if (el.closest("button")) continue;
        if (el.closest("[data-block-text]")) continue;
        const isBackground =
          el === surface ||
          el.hasAttribute("data-block-id") ||
          el.closest("[data-block-id]") === null;
        if (isBackground) return { x, y: clientY };
      }
      return null;
    }, y);

  const requirePoint = async (y: number, what: string) => {
    const p = await backgroundPointAt(y);
    if (!p)
      throw new Error(`no background press point found at y=${y} (${what})`);
    return p;
  };

  /**
   * Park the scroller at an offset and report where it actually landed.
   *
   * A direct `scrollTop` write, not a synthetic wheel: `page.mouse.wheel` was
   * measured to move this surface not at all, and a fixture step that silently
   * does nothing is worse than one that is obviously not a user gesture. Nothing
   * here is under test — this only puts the surface where the next gesture starts.
   * (`no-adhoc-scroll-write` does not apply to `e2e/`, which drives the deployed
   * app rather than composing it.)
   *
   * Passing a huge number is also how the TRUE maximum scroll is discovered: the
   * browser clamps the write, and reading back gives the real bound.
   * `scrollHeight - clientHeight` is only an estimate of it — measured 1473 on a
   * surface that in fact clamps at 1462.
   */
  const parkScroll = async (top: number): Promise<number> =>
    page.evaluate((target) => {
      let n: HTMLElement | null =
        document.querySelector("[data-block-id]")?.parentElement ?? null;
      while (n) {
        const o = getComputedStyle(n).overflowY;
        if (
          (o === "auto" || o === "scroll") &&
          n.scrollHeight > n.clientHeight
        ) {
          n.scrollTop = target;
          return n.scrollTop;
        }
        n = n.parentElement;
      }
      throw new Error("no scroller to park");
    }, top);

  const BOTTOM = 1e9;

  // ---- Fixture: a document several viewports tall ---------------------------

  await openBlankPage(page, { settleMs: 3000 });

  for (let i = 0; i < TYPED_LINES; i++) {
    await page.keyboard.type(`line ${String(i).padStart(2, "0")}`);
    // Settle either side of the split: a keystroke landing within ~20ms of one
    // can be dropped (see the pre-seed note in the editor's CLAUDE.md).
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);

  // Typing 60+ lines is slow and flaky; doubling by paste is neither, and paste
  // is optimistic so each round lands on the keystroke (paste-optimistic-verify).
  // Select-all and copy exactly ONCE, then paste repeatedly. Re-selecting per
  // round would mean re-clicking block 0 between rounds, and that click cannot
  // land: the selection bar is a floating `z-float` strip pinned over the top of
  // the surface, so while a selection is live it covers block 0 — and Escape
  // does not help, because the container's Escape handler only fires for events
  // whose `e.target` IS the container (the origin guard in
  // `internal/use-block-selection.ts`), which is not where focus sits after a
  // paste. Pasting from the state the previous paste left avoids the question.
  await editableBlocks(page).first().click();
  await page.waitForTimeout(500); // outlast the async focus steal before Escape
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+a");
  await page.waitForTimeout(200);
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(400);

  for (let round = 0; round < PASTE_ROUNDS; round++) {
    const before = await blockCount();
    await page.keyboard.press("ControlOrMeta+v");
    for (let i = 0; i < 200 && (await blockCount()) <= before; i++) {
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape");
  // Discover the browser's real clamp before parking back at the top — the loop
  // can only ever be asked to reach THIS, not the `scrollHeight - clientHeight`
  // estimate.
  const trueMax = await parkScroll(BOTTOM);
  await parkScroll(0);
  await page.waitForTimeout(300);

  // ---- 0. Setup -------------------------------------------------------------

  const total = await blockCount();
  const editable = await editableBlocks(page).count();
  const setup = await probeScroller();
  r.note(
    `fixture: ${total} blocks, true max scroll ${Math.round(trueMax)}px ` +
      `(scrollHeight - clientHeight estimates ${Math.round(setup.maxScroll)}px)`,
  );
  // Not pinned to an exact 72: how an empty trailing block round-trips through
  // markdown is a serializer detail, not this spec's subject. What IS load-bearing
  // is that the doc is several viewports tall.
  r.ok(`setup: the fixture is long (${total} blocks)`, total >= 48);
  r.eq("setup: every block is a text block", editable, total);
  r.ok(
    "setup: a scroller exists and actually overflows",
    setup.found && setup.scrollTop >= 0,
  );
  r.ok(
    `setup: the doc is well past the viewport (maxScroll ${Math.round(setup.maxScroll)}px)`,
    setup.maxScroll > 800,
  );

  const bottomEdgeY = setup.bottom - EDGE_INSET;

  // ---- 1. Marquee scrolls under a STATIONARY pointer ------------------------

  const b0Before = await rowRect(0);
  if (!b0Before) throw new Error("no first block");
  const press = await requirePoint(
    b0Before.centerY,
    "right gutter beside block 0",
  );

  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(press.x, press.y + 120); // arms `dragMoved`
  await page.mouse.move(press.x, bottomEdgeY); // parks in the bottom band
  // From here on: NO further pointer events. Anything that moves is the loop.
  const beforeHold = await scrollTop();
  // The range already spans everything on screen, so "> 20 selected" alone would
  // pass without a single new row: what proves the gesture kept extending is that
  // the count GREW while the pointer sat still.
  const selectedAtPark = await selectedCount();
  await page.waitForTimeout(HOLD_MS);
  const afterHold = await scrollTop();
  const grew = afterHold - beforeHold;
  const selectedAfterHold = await selectedCount();

  r.ok(
    `a parked pointer at the bottom edge scrolls the document (+${Math.round(grew)}px in ${HOLD_MS}ms)`,
    grew > 300,
    `scrollTop ${Math.round(beforeHold)} -> ${Math.round(afterHold)}`,
  );
  r.ok(
    `the selection keeps extending while it scrolls (${selectedAtPark} -> ${selectedAfterHold} selected)`,
    selectedAfterHold > selectedAtPark && selectedAfterHold > 20,
  );

  // ---- 2. The marquee anchor stayed on its block ----------------------------
  // The anchor's CONTENT coordinate is constant, so the rectangle's top must
  // still sit on block 0's centre — wherever block 0 has scrolled to. On the
  // unfixed build this is off by the full scroll distance.

  const b0Now = await rowRect(0);
  const mTop = await marqueeTop();
  if (!b0Now) throw new Error("block 0 vanished mid-drag");
  r.ok("the marquee is painted during the drag", mTop !== null);
  r.ok(
    `the marquee anchor tracks block 0 through the scroll (marquee ${mTop === null ? "n/a" : Math.round(mTop)} vs block ${Math.round(b0Now.centerY)})`,
    mTop !== null && Math.abs(mTop - b0Now.centerY) <= 4,
    `scrolled ${Math.round(grew)}px; a drifting anchor is off by exactly that`,
  );

  // ---- 3. Stops at the bottom, and on release -------------------------------

  // Hold until the surface STOPS moving rather than for a fixed span. How far the
  // loop gets per second depends on how fast the consumer's per-frame work runs
  // on this machine, so a fixed hold races the host instead of testing the
  // feature: at ~485px/s the 1473px here needs ~3.04s, and a 3.0s hold failed by
  // 30px on a slower run while passing on a faster one.
  let settledAt = -1;
  let stillCount = 0;
  for (let i = 0; i < 60 && stillCount < 2; i++) {
    await page.waitForTimeout(250);
    const now = await scrollTop();
    stillCount = now === settledAt ? stillCount + 1 : 0;
    settledAt = now;
  }
  const atBottom = await probeScroller();
  // Against the browser's REAL clamp, not `scrollHeight - clientHeight`: the two
  // differ on this surface, and holding the loop to the larger estimate would be
  // asking it to reach an offset the browser will not accept.
  r.ok(
    `the loop drives the surface to the bottom (scrollTop ${Math.round(atBottom.scrollTop)} of ${Math.round(trueMax)})`,
    trueMax - atBottom.scrollTop <= 2,
  );
  r.eq(
    "the range reached every block",
    await selectedCount(),
    await blockCount(),
  );

  await page.mouse.up();
  const onRelease = await scrollTop();
  await page.waitForTimeout(600);
  const afterRelease = await scrollTop();
  r.ok(
    "the loop really stops on pointerup",
    Math.abs(afterRelease - onRelease) <= 1,
    `scrollTop ${Math.round(onRelease)} -> ${Math.round(afterRelease)}`,
  );

  // ---- 4. Text mode: promoted drag scrolls too ------------------------------

  await page.keyboard.press("Escape");
  await parkScroll(0);
  await page.waitForTimeout(300);

  const t0 = await editableBlocks(page).nth(0).boundingBox();
  const t2 = await editableBlocks(page).nth(2).boundingBox();
  if (!t0 || !t2)
    throw new Error("no bounding boxes for the text-drag fixture blocks");

  await page.mouse.move(t0.x + t0.width * 0.3, t0.y + t0.height / 2);
  await page.mouse.down();
  // Crossing into block 2 promotes the gesture to a block range; only then may
  // auto-scroll engage (before that the BROWSER owns the drag).
  await page.mouse.move(t2.x + t2.width * 0.5, t2.y + t2.height / 2, {
    steps: 10,
  });
  await page.mouse.move(t2.x + t2.width * 0.5, bottomEdgeY);
  const textBefore = await scrollTop();
  const textSelectedAtPark = await selectedCount();
  await page.waitForTimeout(HOLD_MS);
  const textAfter = await scrollTop();
  const textSelected = await selectedCount();
  await page.mouse.up();
  await page.waitForTimeout(300);

  r.ok(
    `a promoted text drag scrolls at the edge (+${Math.round(textAfter - textBefore)}px)`,
    textAfter - textBefore > 300,
  );
  r.ok(
    `the promoted range keeps growing (${textSelectedAtPark} -> ${textSelected} selected)`,
    textSelected > textSelectedAtPark && textSelected >= 20,
  );

  // 4b. INTRA-block control, held inside the bottom band. The gesture never
  //     leaves its row, so it is never promoted and OUR loop must stay off —
  //     whatever moves here is the browser's own selection autoscroll, i.e. the
  //     compounding the plan flagged as observable-only. Measured and logged;
  //     only a runaway is a failure.
  await page.keyboard.press("Escape");
  await parkScroll(0);
  await page.waitForTimeout(300);

  const nearEdgeRow = await page.evaluate((targetY) => {
    const els = [
      ...document.querySelectorAll("[data-block-id] [data-block-text]"),
    ];
    let best: { left: number; right: number; centerY: number } | null = null;
    let bestDist = Infinity;
    for (const el of els) {
      const b = el.getBoundingClientRect();
      const centerY = b.top + b.height / 2;
      const dist = Math.abs(centerY - targetY);
      if (dist < bestDist) {
        bestDist = dist;
        best = { left: b.left, right: b.right, centerY };
      }
    }
    return best;
  }, setup.bottom - 20);
  if (!nearEdgeRow) {
    throw new Error(
      "no block near the bottom edge for the intra-block control",
    );
  }

  const intraWidth = nearEdgeRow.right - nearEdgeRow.left;
  await page.mouse.move(
    nearEdgeRow.left + intraWidth * 0.2,
    nearEdgeRow.centerY,
  );
  await page.mouse.down();
  // Horizontal only: the gesture must never leave its own row, or it promotes.
  await page.mouse.move(
    nearEdgeRow.left + intraWidth * 0.6,
    nearEdgeRow.centerY,
    {
      steps: 8,
    },
  );
  const intraBefore = await scrollTop();
  await page.waitForTimeout(1000);
  const intraAfter = await scrollTop();
  await page.mouse.up();
  await page.waitForTimeout(300);
  const intraDelta = intraAfter - intraBefore;
  r.note(
    `intra-block drag held in the bottom band for 1000ms: scrollTop moved ${Math.round(intraDelta)}px ` +
      `(the browser's own selection autoscroll — ours is gated off until promotion)`,
  );
  r.ok(
    `an unpromoted intra-block drag does not run away (${Math.round(intraDelta)}px)`,
    Math.abs(intraDelta) < 1500,
  );

  // ---- 5. The gating control: a stationary press is not a drag --------------
  // The trailing `min-h-40` empty zone sits inside the bottom edge band on a full
  // page. Without the engagement gate this press both scrolls under a motionless
  // pointer AND sets `dragMoved`, swallowing the click-to-edit it was.

  await page.keyboard.press("Escape");
  // MID-document, not the very bottom. At full scroll the editor surface ends
  // ~40px above the scroller's bottom edge (pane padding below the content), so
  // the part of the band nearest the edge is not editor background at all and no
  // press there reaches the gesture. Mid-scroll the band is full of rows, whose
  // gutter rails are background — the same press, and the same gate.
  await parkScroll(trueMax / 2);
  await page.waitForTimeout(300);

  const bottomState = await probeScroller();
  // Walk up from the edge and take the first row that yields a background press
  // point, staying strictly inside the 48px band the loop watches.
  let gatePoint: { x: number; y: number } | null = null;
  for (let d = 8; d <= 44 && !gatePoint; d += 4) {
    gatePoint = await backgroundPointAt(bottomState.bottom - d);
  }
  if (!gatePoint) {
    throw new Error(
      "no background press point anywhere inside the bottom edge band",
    );
  }
  const gateDistanceFromEdge = bottomState.bottom - gatePoint.y;
  r.note(
    `gate press at y=${Math.round(gatePoint.y)}, ${Math.round(gateDistanceFromEdge)}px from the scroller's bottom edge`,
  );
  // The whole point of this step is a press INSIDE the band the loop watches. A
  // press outside it would pass the assertions below for the wrong reason.
  r.ok(
    `the gate press is inside the edge band (${Math.round(gateDistanceFromEdge)}px < 48px)`,
    gateDistanceFromEdge < 48,
  );

  await page.mouse.move(gatePoint.x, gatePoint.y);
  await page.mouse.down();
  const gateBefore = await scrollTop();
  await page.waitForTimeout(1000); // NO movement at all
  const gateAfter = await scrollTop();
  await page.mouse.up();
  await page.waitForTimeout(500);

  r.ok(
    "a motionless press in the edge band does not scroll",
    Math.abs(gateAfter - gateBefore) <= 1,
    `scrollTop ${Math.round(gateBefore)} -> ${Math.round(gateAfter)}`,
  );
  const caretLanded = await page.evaluate(() => {
    const el = document.activeElement;
    return el !== null && el.closest("[data-block-text]") !== null;
  });
  r.ok(
    "click-to-edit still works there (the click was not eaten)",
    caretLanded,
  );

  // ---- 6. Upward ------------------------------------------------------------

  await page.keyboard.press("Escape");
  await parkScroll(BOTTOM);
  await page.waitForTimeout(300);

  const upState = await probeScroller();
  const lastNow = await rowRect((await blockCount()) - 1);
  if (!lastNow) throw new Error("no last block for the upward drag");
  const upPress = await requirePoint(
    lastNow.centerY,
    "gutter beside the last block",
  );

  await page.mouse.move(upPress.x, upPress.y);
  await page.mouse.down();
  const topEdgeY = upState.top + EDGE_INSET;
  await page.mouse.move(upPress.x, upPress.y - 120); // arms `dragMoved`, outside the band
  await page.mouse.move(upPress.x, topEdgeY);
  const upBefore = await scrollTop();
  await page.waitForTimeout(HOLD_MS);
  const upAfter = await scrollTop();
  await page.mouse.up();
  await page.waitForTimeout(300);

  r.ok(
    `a parked pointer at the top edge (y=${Math.round(topEdgeY)}) scrolls back up ` +
      `(${Math.round(upBefore)} -> ${Math.round(upAfter)})`,
    upBefore - upAfter > 300,
  );
});

// Outside `withBrowser`: `finish()` exits the process, which would jump straight
// past the harness's browser teardown if it were called from inside the callback.
await r.finish();
