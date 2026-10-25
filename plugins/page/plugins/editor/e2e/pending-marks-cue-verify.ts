// The collapsed caret's pending-mark cue — "what will the next character carry"
// (research/2026-08-09-page-collapsed-caret-pending-marks-cue.md, "Verification").
//
// A collapsed caret carries a PENDING MARK SET that decides how the next typed
// character is formatted, and until this feature nothing on screen said so: two
// positions that behave differently were pixel-identical. The affordance is two
// arms — show the pending set while the caret stands AT A MARK BOUNDARY (either
// of its two states), or while that set DISAGREES with the marks of the text the
// caret is standing in.
//
// The boundary arm is why phases 3 and 5 read the way they do. Naming only the
// divergent state of a boundary labels one of its two positions and leaves the
// other blank, which is half an affordance: the pair `` `zz|` `` (code) ⇄
// `` `zz`| `` (plain) IS the feature. The divergent arm still extinguishes on
// the next character (phase 2), and ordinary prose still shows nothing at all
// (phase 7), because a run with the void on either side of it is no boundary.
//
// THE SUBJECT OF THIS FILE IS THE DOM, and that is why it is its own script
// rather than a phase of `mark-boundary-verify.ts`. That sibling drives exactly
// the same caret positions (autoformat `` `zz` ``, ArrowRight/ArrowLeft across a
// boundary, the mirrored `` a`zz` `` seam) but asserts the PERSISTED ROWS,
// because its claims are about the data model. Every claim here is about what is
// PAINTED, so every assertion reads the rendered chip and nothing else. Mixing
// the two subjects in one driver is how a DOM-only pass gets mistaken for a data
// claim — so the blocks API is touched here for exactly one thing, the doc-init
// gate in `enterNewBlock`, and never as an assertion subject.
//
// THE PINNED DOM CONTRACT (agreed with the implementation): the chip's outermost
// element carries `data-caret-format-cue="<label>"`, and `<label>` is also its
// visible text. Labels are lowercase, space-joined, in the order
// `bold italic underline strikethrough code`; the empty mark set renders as
// `plain`. So: `plain`, `code`, `bold`, `bold code`.
//
// Phases (each: perform the input, settle past Lexical's format-carry window,
// then read the chip):
//  1. `` `zz` `` autoformats into a `{code}` run → chip reads **plain** with no
//     further keystroke. `applyInlineFormat` restores `preFormat` onto the
//     post-transform caret, so the next character is unmarked — the invisible
//     case that predates the mark-boundary feature entirely;
//  2. type one more character → chip GONE. The self-extinguishing half, and the
//     assertion that the chip is not simply stuck on;
//  3. THE LOAD-BEARING PAIR — the two states of one boundary, named. Fresh
//     `` `zz` ``: ArrowRight → **plain** (the stop, outside the span), ArrowLeft
//     → **code** (back inside), ArrowRight → **plain**. Same pixel, same linear
//     offset, two words. Before this feature neither press painted anything;
//  4. the OTHER two sources, which need no arrow step: Cmd+E on plain text →
//     **code**, then Cmd+B → **bold code** (the label ORDER assertion), then
//     Cmd+E again → **bold**;
//  5. the MIRRORED seam `` a`zz` ``: the seam's natural state → **plain** (left
//     `{}`, right `{code}` is a boundary, so the boundary arm names it), and one
//     ArrowRight into the code run's start → **code**;
//  6. the chip is not sticky: a click elsewhere in the block clears it, and so
//     does blurring the editor. Both re-armed with a fresh Cmd+E first, so
//     neither half can pass vacuously;
//  7. an ordinary plain paragraph never shows it — read after EVERY character,
//     not only at the end;
//  8. WHERE the chip hangs. The only phase that asserts a position, and the only
//     one the anchor read can break: 1-7 read `getClientRects().length > 0` and
//     nothing else, so they pass identically whatever the chip is anchored to.
//
// Manual-only; nothing runs this automatically.
// Usage: bun plugins/page/plugins/editor/e2e/pending-marks-cue-verify.ts [--url <deploy>] [--out /tmp/pending-marks-cue]
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { caretState, openBlankPage } from "./support/blank-page";
import { caretLinear, pressUntilLinear } from "./support/caret";

const out = arg("out", "/tmp/pending-marks-cue");

const r = report();

// `mod+e` is the `code` mark and `mod+b` is `bold`, both in
// `format-shortcuts-plugin.tsx`, which tests `event.metaKey || event.ctrlKey`.
// Playwright's `ControlOrMeta` is Meta on macOS (where this runs) and Control
// everywhere else — exactly that predicate.
const CODE_MARK = "ControlOrMeta+e";
const BOLD_MARK = "ControlOrMeta+b";

// --- waits --------------------------------------------------------------------

/**
 * After an inline-markdown autoformat: the transform runs in a `queueMicrotask`
 * off the update listener, then the collab binding flushes (~300ms debounce).
 */
const TRANSFORM_MS = 500;

/**
 * Idled out before EVERY chip read (see `settledCue`). This is not padding — it
 * is what makes the phases non-vacuous.
 *
 * Lexical's format-divergence carry (`markCollapsedSelectionFormat`) is a ~200ms
 * window keyed on `(anchorKey, offset)`. Phase 1's caret — `format = 0` sitting
 * on a `{code}` node — is exactly the state that window describes, so a chip read
 * INSIDE it could be painted from a value that is about to evaporate, and the
 * phase would pass for the wrong reason. Every read here happens after the window
 * has expired, so only a durable divergence can still be on screen. The same
 * settle covers the render side: the cue is computed synchronously on the
 * selection change, but the commit that paints it is not.
 */
const CUE_SETTLE_MS = 700;

/** A settle short enough that the next character really is the NEXT thing typed. */
const KEYSTROKE_MS = 150;

// --- the chip -----------------------------------------------------------------

/**
 * The single visible cue chip's label, or `null` when no chip is on screen.
 *
 * Reads the ATTRIBUTE, which is the pinned contract, and cross-checks it against
 * the visible text in the same pass — the contract says they are the same string,
 * and a chip that says one thing to a test and another to the user is worth
 * failing on. Both pathological shapes (two chips, attribute ≠ text) come back as
 * a sentinel STRING rather than a throw, so the failing assertion prints the
 * diagnosis instead of aborting the run.
 *
 * Presence is `getClientRects()`, not `offsetParent`: the chip is portaled
 * through `ViewportOverlay` and positioned `fixed`, whose `offsetParent` is
 * `null` even when it is plainly on screen.
 */
async function cueLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const chips = [
      ...document.querySelectorAll("[data-caret-format-cue]"),
    ].filter((el) => el.getClientRects().length > 0);
    if (chips.length === 0) return null;
    const labels = chips.map(
      (el) => el.getAttribute("data-caret-format-cue") ?? "",
    );
    if (chips.length > 1) return `MULTIPLE CHIPS: ${JSON.stringify(labels)}`;
    const attr = labels[0] ?? "";
    const text = (chips[0]?.textContent ?? "").trim();
    return attr === text
      ? attr
      : `ATTR/TEXT MISMATCH: attr=${attr} text=${text}`;
  });
}

/** `cueLabel` after the format-carry window — the only read the phases use. */
async function settledCue(page: Page): Promise<string | null> {
  await page.waitForTimeout(CUE_SETTLE_MS);
  return cueLabel(page);
}

interface CuePlacement {
  /** Viewport `top` of the chip itself (not of the wrapper positioning it). */
  chipTop: number;
  /** Viewport `top` / `bottom` of the whole block element the caret is in. */
  blockTop: number;
  blockBottom: number;
}

/**
 * The chip's vertical position against the block it is describing — phase 8's
 * only subject.
 *
 * Reads the CHIP's own box rather than the absolutely-positioned wrapper's: an
 * `"above"` placement pins the wrapper's bottom edge via `translateY(-100%)`, and
 * `getBoundingClientRect` already accounts for that, so this one read is correct
 * on both sides of the flip.
 */
async function cuePlacement(
  page: Page,
  blockId: string,
): Promise<CuePlacement> {
  const placement = await page.evaluate((id) => {
    const chip = [...document.querySelectorAll("[data-caret-format-cue]")].find(
      (el) => el.getClientRects().length > 0,
    );
    const block = document.querySelector(`[data-block-id="${id}"]`);
    if (!chip || !block) return null;
    const c = chip.getBoundingClientRect();
    const b = block.getBoundingClientRect();
    return { chipTop: c.top, blockTop: b.top, blockBottom: b.bottom };
  }, blockId);
  if (!placement) throw new Error(`no chip and/or block ${blockId} on screen`);
  return placement;
}

/**
 * Does the caret stand at a position its OWN collapsed range paints nothing for?
 *
 * That is the precondition phase 8 needs, and it is the case the anchor read
 * exists for — an empty soft line, where `getClientRects()` on the collapsed
 * range is empty and the line box has to be borrowed from the neighbouring node.
 * Asserting it before the placement read is what stops the phase passing
 * vacuously against a caret that never reached the blank line.
 *
 * The range is rebuilt from `(anchorNode, anchorOffset)` rather than taken from
 * `getRangeAt(0)`: identical for a collapsed selection, and `getRangeAt` is
 * routed through `primitives/dom/dom-selection` everywhere in this repo.
 */
async function caretPaintsNothing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !sel.isCollapsed) return false;
    const range = document.createRange();
    range.setStart(sel.anchorNode, sel.anchorOffset);
    range.collapse(true);
    return ![...range.getClientRects()].some(
      (rc) => rc.width !== 0 || rc.height !== 0,
    );
  });
}

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

// --- caret placement ----------------------------------------------------------

/**
 * Park the caret at the very START of `id`'s text.
 *
 * Home / Cmd+ArrowLeft do not move the caret in headless Chromium on macOS (two
 * sibling scripts say so), so this is the click-the-left-edge + exact-count
 * ArrowLeft fallback. It stops the MOMENT the offset reads 0, which matters: one
 * further ArrowLeft at a block-start boundary is a virtual step, and this file's
 * phase 5 must arrive at its seam having spent no press it did not intend.
 */
async function caretToStartOf(page: Page, id: string): Promise<void> {
  await editableOf(page, id).click({ position: { x: 2, y: 8 } });
  await page.waitForTimeout(200);
  for (let guard = 0; guard < 40; guard++) {
    if ((await caretLinear(page)) <= 0) return;
    await page.keyboard.press("ArrowLeft");
  }
  throw new Error(`caret never reached the start of ${id}`);
}

/** Park the caret at the very END of `id`'s text — Enter's "new block below". */
async function caretToEndOf(page: Page, id: string): Promise<void> {
  const editable = editableOf(page, id);
  const box = await editable.boundingBox();
  if (!box) throw new Error(`block ${id} has no box`);
  const len = await editable.evaluate((el) => (el.textContent ?? "").length);
  await editable.click({ position: { x: Math.max(box.width - 4, 4), y: 8 } });
  await page.waitForTimeout(200);
  for (let guard = 0; guard < 60; guard++) {
    if ((await caretLinear(page)) >= len) return;
    await page.keyboard.press("ArrowRight");
  }
  throw new Error(`caret never reached the end of ${id}`);
}

// --- authoring helpers --------------------------------------------------------

/**
 * Does `blockId`'s ROW exist server-side yet?
 *
 * The ONLY server read in this file, and deliberately not an assertion: it is the
 * doc-init gate. A freshly split block mounts its editor from the optimistic
 * overlay BEFORE the structural POST creates its `page_blocks` row, and its
 * content `Y.Doc` cannot seed until that row is confirmed — so typing into that
 * gap races the seed, which every phase here opens by doing. The sibling scripts
 * document the two failures observed while this was a blind sleep.
 */
async function blockRowExists(
  pageId: string,
  blockId: string,
): Promise<boolean> {
  const res = await agentFetch(`/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`blocks fetch ${res.status}`);
  const rows = (await res.json()) as { id: string }[];
  return rows.some((row) => row.id === blockId);
}

/**
 * A fresh empty block at the end of the document, whose id is returned.
 *
 * Parks the caret at the end of the LAST block first, because two phases here
 * deliberately leave it mid-block (the seam in 5, the click in 6) and Enter there
 * would SPLIT rather than append. Diffs the id sets rather than assuming "the new
 * block is last" — a silent mis-identification would attribute the next phase's
 * chip reads to the wrong caret.
 */
async function enterNewBlock(page: Page, pageId: string): Promise<string> {
  const before = await editableIds(page);
  const last = before.at(-1);
  if (!last) throw new Error("document has no editable block");
  await caretToEndOf(page, last);
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
    if (await blockRowExists(pageId, id)) break;
    if (Date.now() > deadline)
      throw new Error(`block ${id} never reached the server`);
    await page.waitForTimeout(250);
  }
  // The row is confirmed, so doc-init is unblocked; give its round trip a beat
  // before the first keystroke.
  await page.waitForTimeout(800);
  return id;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });

  // The scratch page is created through the shared blank-page flow, so it carries
  // the harness's origin header (`agent`): the agent-origin plugin
  // segregates it out of the user's tree and sweeps it after 24h. Same lifecycle
  // as every sibling script — nothing here deletes a page by hand.
  const {
    pageUrl,
    pageId,
    blockId: firstId,
  } = await openBlankPage(page, { settleMs: 3000 });
  console.log("page url:", pageUrl);
  console.log("PAGE_ID:", pageId);

  // A blank document must not be showing a chip before anything is typed.
  r.eq("P0 no chip on a fresh empty block", await settledCue(page), null);

  // --- Phase 1: an autoformat landing paints the cue with no keystroke -------
  //
  // The gap that predates the virtual-delimiter feature. `applyInlineFormat`
  // snapshots `preFormat` and restores it onto the post-transform caret, so the
  // caret standing on the new `{code}` run will type UNMARKED text — invisibly,
  // on the single most common path in the editor. `settledCue` is what makes this
  // a claim about the feature rather than about Lexical's ~200ms carry window
  // (see `CUE_SETTLE_MS`).
  const p1 = firstId;
  await page.keyboard.type("`zz`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  // Diagnostic, not an assertion: a caret that MOVED (or left the block) explains
  // a phase-1 failure that the chip alone would not.
  console.log(
    "P1 caret after the transform:",
    JSON.stringify(await caretState(editableOf(page, p1))),
    "linear:",
    await caretLinear(page),
  );
  const p1Cue = await settledCue(page);
  await snap(page, out, "1-autoformat-landing");
  r.eq(
    "P1 the autoformat landing says the next character is plain",
    p1Cue,
    "plain",
  );

  // --- Phase 2: it is SELF-EXTINGUISHING -------------------------------------
  // The typed character creates a run carrying the pending marks, so surrounding
  // and pending agree — and, the half the boundary arm makes worth stating, the
  // caret is no longer at a boundary either: the new UNMARKED run's right
  // neighbour is the block edge, i.e. the empty unmarked void, so the two sides
  // are equal and there is no seam. This is also the only assertion that proves
  // the chip is a live predicate rather than something that latches on and stays.
  await page.keyboard.type("x", { delay: 25 });
  const p2Cue = await settledCue(page);
  await snap(page, out, "2-self-extinguishing");
  r.eq("P2 one typed character clears the chip", p2Cue, null);

  // --- Phase 3: THE LOAD-BEARING PAIR ----------------------------------------
  //
  // The mark-boundary feature's whole visible surface: at the end of `` `zz` ``
  // the caret has two states — inside the span and outside it — at the same pixel
  // and the same linear offset, and before this affordance NOTHING distinguished
  // them. The chip reading a DIFFERENT WORD at each IS the feature: `code` inside
  // the run, `plain` on the stop outside it. The inside read is the boundary arm
  // (pending and surrounding agree there, so the divergence test alone would say
  // nothing and leave half the pair unlabelled — which is what shipped first).
  //
  // The press counts are `mark-boundary-verify.ts`'s phases 1 and 2, which pin
  // them on the persisted rows: from the post-transform caret (already at the
  // boundary's `natural` state, inside the span) ONE ArrowRight reaches the stop,
  // and ONE ArrowLeft from the stop steps back inside. The plan's shorthand for
  // this phase elides that first press because the autoformat has already left
  // the caret there; spelling it out is what makes the ArrowLeft/ArrowRight pair
  // below a round trip between the two states rather than a walk into the text.
  const p3 = await enterNewBlock(page, pageId);
  await page.keyboard.type("`zz`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.press("ArrowRight"); // onto the stop, OUTSIDE the span
  const p3Out = await settledCue(page);
  r.eq("P3 ArrowRight onto the stop says plain", p3Out, "plain");

  await page.keyboard.press("ArrowLeft"); // back INSIDE the span
  const p3In = await settledCue(page);
  await snap(page, out, "3-back-inside");
  r.eq("P3 stepping back inside the span says code", p3In, "code");

  await page.keyboard.press("ArrowRight"); // out again — the press that used to paint nothing
  const p3OutAgain = await settledCue(page);
  await snap(page, out, "3-stepped-out");
  r.eq("P3 stepping out again says plain again", p3OutAgain, "plain");

  // --- Phase 4: the sources that need no arrow step at all -------------------
  //
  // `FormatShortcutsPlugin` fires on a collapsed caret BY DESIGN — Lexical's
  // collapsed branch of `formatText` is a pure selection toggle — so Cmd+E on
  // plain text arms `{code}` for the next character with no confirmation of any
  // kind today. The three reads also pin the LABEL CONTRACT: the set is rendered
  // in `bold italic underline strikethrough code` order, so `{bold, code}` is
  // "bold code" and never "code bold".
  //
  // The two `BOLD_MARK` reads below FAILED from 2026-08-09 to 2026-08-16, and the
  // cue was right to say so: ⌘B (and ⌘I and ⌘U) armed nothing, because Lexical
  // dispatched the format once from its own keydown branch and this editor's
  // shortcut table dispatched it again, toggling the mark straight back off. They
  // were deliberately left red rather than weakened, and they are what made a
  // defect visible that nothing had ever displayed before this cue existed. Fixed
  // in `format-shortcuts-plugin.tsx` (read its header) — the shortcut table now
  // has its own spec in `format-shortcuts-verify.ts`, so a regression here would
  // be a second signal rather than the only one.
  const p4 = await enterNewBlock(page, pageId);
  await page.keyboard.type("plain", { delay: 25 });
  await page.waitForTimeout(KEYSTROKE_MS);
  r.eq("P4 ordinary typing shows no chip", await settledCue(page), null);

  await page.keyboard.press(CODE_MARK);
  r.eq("P4 Cmd+E arms code", await settledCue(page), "code");

  await page.keyboard.press(BOLD_MARK);
  const p4Both = await settledCue(page);
  await snap(page, out, "4-bold-code");
  r.eq("P4 Cmd+B as well arms bold code, in label order", p4Both, "bold code");

  await page.keyboard.press(CODE_MARK);
  r.eq("P4 Cmd+E again leaves bold alone", await settledCue(page), "bold");

  // --- Phase 5: the MIRRORED seam --------------------------------------------
  //
  // `` a`zz` `` — the marked run on the RIGHT. The seam resolves to the END of
  // the earlier (plain) run, so the caret's natural marks there are `{}` and the
  // state the browser never produces is the one INSIDE the code run at its start:
  // typing there PREPENDS into the span. It is the row a `left ∩ right` rule got
  // wrong by synthesizing no stop at all, so it is exactly the row worth pinning
  // on the visible side too — the chip is the only thing that says which of the
  // two identical-looking positions the caret is in.
  const p5 = await enterNewBlock(page, pageId);
  // The backtick delimiter is intraword-legal (`INLINE_SYNTAXES`), so this
  // autoformats as one typed sequence.
  await page.keyboard.type("a`zz`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await caretToStartOf(page, p5);
  const p5Presses = await pressUntilLinear(page, "ArrowRight", 1);
  r.ok(
    "P5 the caret reached the a|`zz` seam",
    p5Presses >= 0,
    `presses=${p5Presses}`,
  );
  // At the seam's natural state pending and surrounding agree (both `{}`) — but
  // it IS a boundary (left `{}`, right `{code}`), and the state one press away
  // types into the code run. So the boundary arm names this one `plain`; without
  // it the caret's two states here would again be one word and one blank.
  r.eq(
    "P5 the seam's natural state says plain",
    await settledCue(page),
    "plain",
  );

  await page.keyboard.press("ArrowRight"); // absorbed by the stop, INSIDE the code run
  const p5Cue = await settledCue(page);
  await snap(page, out, "5-mirrored-seam");
  r.eq("P5 one ArrowRight into the code run's start says code", p5Cue, "code");
  console.log("P5 caret linear at the stop:", await caretLinear(page));

  // --- Phase 6: the chip is not sticky ---------------------------------------
  //
  // Two ways the pending state stops being the user's business: they move the
  // caret somewhere else, or they leave the editor. Each half re-arms the chip
  // with a fresh Cmd+E and asserts it is ON first, so a chip that never rendered
  // at all could not pass either of them.
  const p6 = await enterNewBlock(page, pageId);
  await page.keyboard.type("hello there", { delay: 25 });
  await page.waitForTimeout(KEYSTROKE_MS);
  await page.keyboard.press(CODE_MARK);
  r.eq("P6 the chip is armed before the click", await settledCue(page), "code");

  // A click is not a crossing: the selection is re-derived from the anchor node,
  // so pending and surrounding agree again wherever it lands — and the block is
  // one unmarked run, so no landing in it is at a boundary either.
  await editableOf(page, p6).click({ position: { x: 2, y: 8 } });
  const p6AfterClick = await settledCue(page);
  await snap(page, out, "6-after-click");
  r.eq(
    "P6 clicking elsewhere in the block clears the chip",
    p6AfterClick,
    null,
  );

  await page.keyboard.press(CODE_MARK);
  r.eq(
    "P6 the chip is armed again before the blur",
    await settledCue(page),
    "code",
  );

  await page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement) el.blur();
  });
  const p6AfterBlur = await settledCue(page);
  await snap(page, out, "6-after-blur");
  r.eq("P6 blurring the editor clears the chip", p6AfterBlur, null);

  // --- Phase 7: ordinary typing never shows it -------------------------------
  //
  // The cost side of the feature: a chip that flashed during normal prose would
  // be noise on every line. Read after EVERY character rather than once at the
  // end — a chip that appears for one keystroke and clears on the next is exactly
  // what a final read cannot see. Deliberately NOT `settledCue`: these reads are
  // meant to land DURING the typing, where a spurious chip would live.
  const p7 = await enterNewBlock(page, pageId);
  const prose = "the quick brown fox";
  const seen: string[] = [];
  for (const ch of prose) {
    await page.keyboard.type(ch, { delay: 0 });
    await page.waitForTimeout(120);
    const label = await cueLabel(page);
    if (label !== null) seen.push(`${ch}→${label}`);
  }
  await snap(page, out, "7-plain-paragraph");
  r.ok(
    "P7 an ordinary paragraph never shows the chip",
    seen.length === 0,
    JSON.stringify(seen),
  );
  r.eq("P7 ...nor after it settles", await settledCue(page), null);
  {
    // The prose really was typed — without this, a run where every keystroke was
    // swallowed would pass phase 7 while asserting nothing at all.
    const typed = (await editableOf(page, p7).innerText())
      .replace(/ /g, " ")
      .trim();
    r.ok(
      "P7 the paragraph reached the editor",
      typed === prose,
      JSON.stringify(typed),
    );
  }

  // --- Phase 8: the chip hangs on the CARET'S LINE, not under the block ------
  //
  // Every phase above reads the chip's LABEL; this one reads where it is. The
  // fixture is a block with THREE visual lines — "alpha" / "" / "omega" — with
  // the caret parked on the empty middle one, which is a position a collapsed
  // range paints nothing for. So the cue's anchor read cannot use the caret's own
  // range and has to answer some other way, and which way it answers is the whole
  // question:
  //
  //   - the caret's LINE box (today): the chip hangs between lines 2 and 3, i.e.
  //     ABOVE the block's bottom edge, right under the line it describes;
  //   - the editor root's whole box (before): the chip hangs ~8px BELOW the
  //     entire block, two lines away from the caret — wrong on both axes, and
  //     invisible to a probe that only asks whether the chip is painted.
  //
  // Hence a comparison rather than a pixel: the chip's top must sit above the
  // block's bottom. On this fixture the two readings are a full line apart, so
  // the assertion has real margin without pinning any coordinate.
  const p8 = await enterNewBlock(page, pageId);
  await page.keyboard.type("alpha", { delay: 25 });
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("omega", { delay: 25 });
  await page.waitForTimeout(400);
  // ArrowUp off the last line: the block's own line logic keeps the caret inside
  // the block (only its TOP line crosses upward), so this lands on the blank one.
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(400);
  r.ok(
    "P8 the caret reached the empty soft line (its own range paints nothing)",
    await caretPaintsNothing(page),
    JSON.stringify(await caretState(editableOf(page, p8))),
  );

  await page.keyboard.press(CODE_MARK);
  r.eq(
    "P8 Cmd+E on the blank line arms the chip",
    await settledCue(page),
    "code",
  );

  const p8Place = await cuePlacement(page, p8);
  await snap(page, out, "8-empty-soft-line-anchor");
  r.ok(
    "P8 the chip hangs on the caret's line, not below the whole block",
    p8Place.chipTop < p8Place.blockBottom && p8Place.chipTop > p8Place.blockTop,
    JSON.stringify(p8Place),
  );

  console.log("PAGE_URL:", pageUrl);
  console.log("BLOCK_IDS:", JSON.stringify({ p1, p3, p4, p5, p6, p7, p8 }));

  await r.finish();
});
