// A void CONTAINER folds to its BORROWED line.
//
// A container renders no line of its own — its content IS its children — which
// is why it shipped as `collapsible: "never"`: there was no row to hang a
// chevron on, so a collapsed container would have hidden its children behind
// nothing. The fold resolves that by borrowing the first child's line, exactly
// as the anchor already borrows it to seat its gutter decoration:
//
//   > A collapsed container renders exactly its first visible LINE and nothing
//   > else.
//
// Everything below is invisible to a unit test, and most of it is invisible to
// jsdom, because the load-bearing claims are about HIT-TESTING and PAINTED
// RECTS on the real surface:
//
//  1. THE CHEVRON IS ON THE BORROWED LINE, AND IT TARGETS THE CONTAINER. The
//     container's row hosts none. This is forced, not chosen: `resolveRailSeats`
//     seats a container and its whole subtree at ONE `left`, so there is
//     exactly one chevron slot on that line for both of them.
//  2. THE DEADLOCK TEST — HOVERING THE BORROWED LINE REVEALS IT. Gutter controls
//     are `opacity-0 pointer-events-none` until their row is hovered, and an
//     anchor row is ZERO-HEIGHT by design. A chevron rendered in the container's
//     own row could therefore never be hovered, and collapse would be
//     unreachable while expanded (only re-expanding would work, since a collapsed
//     chevron is pinned). Asserted by parking the pointer over the borrowed
//     line's TEXT and reading the chevron's computed `opacity`/`pointer-events`
//     — a `.click()` alone cannot say WHICH half broke, since Playwright
//     hit-tests before it moves the pointer and so times out identically for a
//     stuck `opacity` and for a stuck `pointer-events`.
//  3. FOLDING SHOWS ONE LINE AND MOVES NOTHING. The children below the borrowed
//     line leave the DOM, the box shrinks to about one line, and the borrowed
//     line's own top is UNCHANGED — the fold must not make the page jump under
//     the reader's eyes.
//  4. A COLLAPSED CONTAINER IS ALWAYS REVERSIBLE. Its chevron is pinned visible
//     with the pointer parked far away. This is the structural guarantee that
//     replaced `collapsible: "never"`: whatever a stray `expanded: false` says,
//     the box still paints a line and that line still carries the way back out.
//  5. ENTER ON A COLLAPSED BOX'S LINE DOES NOT EAT THE TAIL. `applySplit` was the
//     one reducer op that did not open its destination parent, so the tail landed
//     among the folded children — no row, no Lexical instance — while the
//     executor had already truncated the origin's live doc. The text after the
//     caret simply vanished. Both halves of the split must be on screen after.
//  6. THE FOLD IS PERSISTED STRUCTURE, not view state: it survives a reload in a
//     fresh browser context.
//
// The container under test is `callout` (a solid tint). The behaviour belongs to
// the `container` primitive, so `context` inherits it unchanged — which is why
// this spec lives here and not in either consumer.
//
// Usage: bun plugins/page/plugins/container/e2e/container-collapse-verify.ts [--url <deploy>] [--out /tmp/collapse]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import {
  caretState,
  openBlankPage,
  pageIdFromUrl,
} from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/collapse");
const r = report();

/** Record one failure and stop. Used where nothing further is checkable. */
async function bail(name: string, detail: string): Promise<never> {
  r.fail(name, detail);
  return await r.finish();
}

interface ChevronProbe {
  /** Which block the chevron on this row toggles, or null when it hosts none. */
  target: string | null;
  opacity: number;
  pointerEvents: string;
  /** Does a hit-test at the chevron's centre actually land on the button? */
  clickable: boolean;
}

/** Read the chevron hosted by `blockId`'s row, as the user's pointer finds it. */
async function chevron(page: Page, blockId: string): Promise<ChevronProbe> {
  return page.evaluate((id) => {
    const row = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
    const btn = row?.querySelector<HTMLElement>("[data-chevron-for]") ?? null;
    if (!btn)
      return {
        target: null,
        opacity: 0,
        pointerEvents: "none",
        clickable: false,
      };
    const style = getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      target: btn.getAttribute("data-chevron-for"),
      opacity: parseFloat(style.opacity || "0"),
      pointerEvents: style.pointerEvents,
      clickable: hit !== null && (hit === btn || btn.contains(hit)),
    };
  }, blockId);
}

/** The ids currently rendered, in document order. */
async function rendered(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")]
      .map((el) => el.getAttribute("data-block-id"))
      .filter((id): id is string => id !== null),
  );
}

/** A row's top edge and height, or null when it is not rendered. */
async function rect(
  page: Page,
  id: string,
): Promise<{ top: number; height: number } | null> {
  return page.evaluate((blockId) => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"]`,
    );
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { top: box.top, height: box.height };
  }, id);
}

/** The painted container backdrop's height — the box the reader sees. */
async function boxHeight(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const anyRow = document.querySelector<HTMLElement>("[data-block-id]");
    const grid = anyRow?.parentElement?.parentElement;
    for (const child of grid ? [...grid.children] : []) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.querySelector("[data-block-id]") !== null) continue;
      const h = child.getBoundingClientRect().height;
      if (h > 0) return h;
    }
    return null;
  });
}

/**
 * Park the pointer over a row's text, well clear of the gutter controls.
 *
 * A row that is not on screen is a hard STOP, not a move quietly skipped. The
 * chevron this hover was going to reveal stays `pointer-events-none` without
 * it, so every later click on it spins out its whole timeout against a hit test
 * that can never pass — which is how a page that simply had not finished
 * rendering used to surface, 30s downstream, as an inexplicably unclickable
 * control. Bail where the fault actually is.
 */
async function hoverText(page: Page, id: string): Promise<void> {
  const box = await page.evaluate((blockId) => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"]`,
    );
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width * 0.6, y: b.top + Math.min(12, b.height / 2) };
  }, id);
  if (!box)
    return await bail(`hover: ${id} is on screen`, "no such row in the DOM");
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(200);
}

async function clickChevron(page: Page, rowId: string): Promise<void> {
  await page
    .locator(`[data-block-id="${rowId}"] [data-chevron-for]`)
    .first()
    .click();
  await page.waitForTimeout(900);
}

/**
 * Put the caret `fromEnd` characters back from the end of `blockId`'s text and
 * press Enter, returning the caret as Lexical had it.
 *
 * Clicking at a fraction of the editable's WIDTH does not work: the editable
 * spans the row, so a click past a short line lands at its end. That end is
 * deterministic though, so the caret is walked back from there — and then
 * VERIFIED, because a split spec whose caret silently drifted to the end tests
 * an empty tail, which is exactly the case that cannot fail.
 */
async function splitBackFromEnd(
  page: Page,
  blockId: string,
  fromEnd: number,
): Promise<{ offset: number; length: number }> {
  const editable = page
    .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
    .first();
  const box = await editable.boundingBox();
  if (!box)
    return await bail(
      `split: ${blockId} exposes an editable surface`,
      "no bounding box",
    );
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.waitForTimeout(400);
  for (let i = 0; i < fromEnd; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(250);

  const caret = await caretState(editable);
  const offset = caret.anchorOffset ?? -1;
  const length = caret.anchorTextLength ?? -1;
  if (
    !caret.hasSelection ||
    caret.insideBlock !== true ||
    offset !== length - fromEnd
  ) {
    return await bail(
      `split: the caret is mid-text in ${blockId} before Enter`,
      JSON.stringify(caret),
    );
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  return { offset, length };
}

/** The visible text of every rendered row, in document order. */
async function texts(
  page: Page,
): Promise<{ id: string | null; text: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-block-id]")].map(
      (el) => ({
        id: el.getAttribute("data-block-id"),
        text: el.innerText.trim(),
      }),
    ),
  );
}

/** Did `whole` end up split into a visible head and a visible tail? */
function bothHalvesVisible(rows: { text: string }[], whole: string): boolean {
  const seen = rows.map((b) => b.text);
  const head = seen.some(
    (t) => t.length > 0 && t !== whole && whole.startsWith(t),
  );
  const tail = seen.some(
    (t) => t.length > 0 && t !== whole && whole.endsWith(t),
  );
  return head && tail;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const doc = await openBlankPage(page, { settleMs: 800 });
  const pageId = pageIdFromUrl(doc.pageUrl);

  // A callout with THREE children: enough that folding hides something, and the
  // first child gets a subtree of its own so the "whose chevron is it" rule is
  // actually exercised rather than trivially satisfied.
  const seeded = await (async () => {
    const post = async (body: unknown) => {
      const res = await pageFetch(page, "/api/blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`POST /api/blocks ${res.status}: ${await res.text()}`);
      return (await res.json()) as { id: string };
    };
    const box = await post({
      parentId: pageId,
      type: "callout",
      data: { icon: null, color: "info" },
    });
    const text = (parentId: string, body: string) =>
      post({ parentId, type: "text", data: { text: [{ text: body }] } });
    const first = await text(box.id, "first line");
    const second = await text(box.id, "second line");
    const third = await text(box.id, "third line");
    const after = await text(pageId, "after the box");
    return {
      box: box.id,
      first: first.id,
      second: second.id,
      third: third.id,
      after: after.id,
    };
  })();
  console.log("seeded:", JSON.stringify(seeded));

  await page.reload({ waitUntil: "domcontentloaded" });
  // WAIT for the seed to be on screen; do not guess a settle time — the same
  // rule the cold-load check at the foot of this file already states, and for
  // the same reason. A cold SPA boot paints its first row 2–3s after
  // `domcontentloaded` (measured), so the fixed 1600ms pause this used to take
  // resumed against a BLANK page, where "no children rendered" reads as "the
  // fold hid them" and the first hover reveals nothing. The wait is on the LAST
  // row posted, so its arrival proves the whole seed is rendered rather than
  // the head of it.
  await page
    .locator(`[data-block-id="${seeded.after}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "1-expanded");

  const openIds = await rendered(page);
  r.ok(
    "expanded: every child of the box is on screen",
    [seeded.first, seeded.second, seeded.third].every((id) =>
      openIds.includes(id),
    ),
    JSON.stringify(openIds),
  );

  // --- 1. The chevron is on the BORROWED line, and it targets the CONTAINER ---
  const anchorRow = await chevron(page, seeded.box);
  r.ok(
    "the container's own row hosts NO chevron (it is zero-height and unhoverable)",
    anchorRow.target === null,
    `target=${anchorRow.target}`,
  );

  await hoverText(page, seeded.first);
  const borrowed = await chevron(page, seeded.first);
  console.log("borrowed-line chevron:", JSON.stringify(borrowed));
  r.ok(
    "the borrowed line's chevron targets the CONTAINER, not the line's own block",
    borrowed.target === seeded.box,
    `target=${borrowed.target} box=${seeded.box} first=${seeded.first}`,
  );

  // --- 2. The deadlock: hovering the borrowed line REVEALS it -----------------
  r.ok(
    "hovering the borrowed line reveals the chevron (opacity > 0)",
    borrowed.opacity > 0,
    `opacity=${borrowed.opacity}`,
  );
  r.ok(
    "...and it accepts the pointer — the collapse direction is reachable at all",
    borrowed.pointerEvents !== "none" && borrowed.clickable,
    `pointerEvents=${borrowed.pointerEvents} clickable=${borrowed.clickable}`,
  );

  // --- 3. Folding shows one line and moves nothing ----------------------------
  const firstTopOpen = await rect(page, seeded.first);
  const boxOpen = await boxHeight(page);
  await clickChevron(page, seeded.first);
  await snap(page, out, "2-collapsed");

  const foldedIds = await rendered(page);
  console.log("rendered when folded:", JSON.stringify(foldedIds));
  r.ok(
    "folded: the borrowed line still renders",
    foldedIds.includes(seeded.first),
    JSON.stringify(foldedIds),
  );
  r.ok(
    "folded: the lines below it are gone",
    !foldedIds.includes(seeded.second) && !foldedIds.includes(seeded.third),
    JSON.stringify(foldedIds),
  );
  r.ok(
    "folded: content OUTSIDE the box is untouched",
    foldedIds.includes(seeded.after),
    JSON.stringify(foldedIds),
  );

  const firstTopFolded = await rect(page, seeded.first);
  r.ok(
    "folded: the borrowed line does not move — the page must not jump",
    firstTopOpen != null &&
      firstTopFolded != null &&
      Math.abs(firstTopOpen.top - firstTopFolded.top) <= 2,
    `open=${firstTopOpen?.top} folded=${firstTopFolded?.top}`,
  );

  const boxFolded = await boxHeight(page);
  r.ok(
    "folded: the painted box shrinks to about one line",
    boxOpen != null && boxFolded != null && boxFolded < boxOpen * 0.7,
    `open=${boxOpen} folded=${boxFolded}`,
  );

  // --- 4. A collapsed container is always reversible --------------------------
  // Park the pointer far away: a pinned chevron must not depend on hover, or a
  // folded box would be a one-way door for anyone who moved the mouse.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  const pinned = await chevron(page, seeded.first);
  console.log("pinned chevron (pointer parked away):", JSON.stringify(pinned));
  r.ok(
    "folded: the chevron is PINNED visible with the pointer elsewhere",
    pinned.target === seeded.box && pinned.opacity > 0 && pinned.clickable,
    JSON.stringify(pinned),
  );

  await clickChevron(page, seeded.first);
  const reopened = await rendered(page);
  r.ok(
    "clicking it again restores every folded line",
    [seeded.second, seeded.third].every((id) => reopened.includes(id)),
    JSON.stringify(reopened),
  );
  await snap(page, out, "3-reopened");

  // --- 5. Enter on a collapsed box's line does not eat the tail ---------------
  //
  // Run the CONTROL first: the identical gesture on an OPEN box. Without it a
  // failure below cannot be read — a mid-line split that also fails when open is
  // the harness's caret, not the fold's.
  const openCaret = await splitBackFromEnd(page, seeded.third, 5); // "third| line"
  const afterOpenSplit = await texts(page);
  console.log("control (open box) caret:", JSON.stringify(openCaret));
  console.log(
    "control (open box) after split:",
    JSON.stringify(afterOpenSplit),
  );
  r.ok(
    "CONTROL: a mid-line Enter inside an OPEN box splits the line in two",
    bothHalvesVisible(afterOpenSplit, "third line"),
    JSON.stringify(afterOpenSplit.map((b) => b.text)),
  );

  await hoverText(page, seeded.first);
  await clickChevron(page, seeded.first);
  const foldedCaret = await splitBackFromEnd(page, seeded.first, 5); // "first| line"
  await snap(page, out, "4-split-inside-folded");

  const afterSplit = await texts(page);
  console.log("folded-box caret:", JSON.stringify(foldedCaret));
  console.log("after split:", JSON.stringify(afterSplit));
  // Both halves of the line the caret was standing in must still be on screen —
  // the tail landing in a folded slot is exactly how the text used to vanish.
  r.ok(
    "Enter inside a folded box keeps BOTH halves of the split on screen",
    bothHalvesVisible(afterSplit, "first line"),
    JSON.stringify(afterSplit.map((b) => b.text)),
  );
  r.ok(
    "...by opening the box, so its other lines come back too",
    afterSplit.some((b) => b.id === seeded.second),
    JSON.stringify(afterSplit.map((b) => b.id)),
  );

  // --- 6. The fold is persisted structure ------------------------------------
  await hoverText(page, seeded.first);
  await clickChevron(page, seeded.first);
  await page.waitForTimeout(1200);

  // A SECOND browser context, not another tab in this one: own storage, own
  // socket, cold load. That is what makes this a claim about persisted rows
  // rather than about anything cached in the first session.
  const second = await h.session({ label: "B" });
  await second.page.goto(doc.pageUrl, { waitUntil: "domcontentloaded" });
  // WAIT for the borrowed line, do not guess a settle time: a cold context loads
  // the SPA from scratch, and a fixed pause read "no blocks rendered" as "the
  // fold hid them" — a false PASS in the making, and the reason this reads the
  // one row the claim is about rather than sleeping.
  await second.page
    .locator(`[data-block-id="${seeded.first}"]`)
    .waitFor({ state: "visible", timeout: 30_000 });
  await second.page.waitForTimeout(600);
  const afterReload = await rendered(second.page);
  console.log("after cold load:", JSON.stringify(afterReload));
  r.ok(
    "the fold survives a cold load in a fresh context — it is structure, not view state",
    afterReload.includes(seeded.first) && !afterReload.includes(seeded.third),
    JSON.stringify(afterReload),
  );
  await snap(second.page, out, "5-cold-load");
  await second.context.close();
});

await r.finish();
