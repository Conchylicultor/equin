/**
 * Verifies the queue's Done section pages as the user scrolls: its header
 * reads the EXACT number of ended conversations from the first paint (the
 * collection's `:count`, not "30+"), and stays put while pages load; more rows
 * page in once the tail scrolls into view, and none while the Done section is
 * collapsed (the sentinel is then right under the header, so an ungated
 * observer would page the whole history in).
 *
 * Then it leaves Done and comes back: after a deep scroll down the sidebar,
 * it scrolls up until the Done header is below the screen and waits past the
 * viewport's settle (Done's far pages are released — under `isPaged` they
 * simply leave the rows, with no placeholder), scrolls back down, and checks
 * every Done row seen on the way in is seen again, once, in the same order,
 * with the header's count unchanged; then that scrolling to the tail still
 * pages in rows past it. A conversation ending mid-run lands at Done's head
 * and reads as a new row there, which the order check tolerates.
 *
 *   ./singularity run plugins/conversations/plugins/conversations-view/plugins/data-view/plugins/queue/e2e/done-paging.ts [--deep-rows 150] [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  numArg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/queue-done-paging";
/** How many Done rows the deep scroll reads through before turning back. */
const DEEP_ROWS = numArg("deep-rows", 150);
/** Longer than the viewport's settle (`SETTLE_MS` 250 ms, `MAX_WAIT_MS` 1 s). */
const PAST_SETTLE_MS = 3000;
const ROW = "[data-row-key]:not([data-page-placeholder])";
const HEADER = /^[A-Z][\w ]*\s+\d+\+?$/;

/** The Done header's count. */
async function doneCount(page: Page): Promise<number> {
  const m = /(\d+)/.exec(await doneHeader(page));
  return m ? Number(m[1]) : -1;
}

/** The Done header's text (label + count). */
async function doneHeader(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll("button"))
        .find((b) =>
          /^Done\s+\d+\+?$/.test(b.innerText.trim().replace(/\s+/g, " ")),
        )
        ?.innerText.replace(/\s+/g, " ")
        .trim() ?? "",
  );
}

/** Click the Done header (collapse / expand the section). */
async function toggleDone(page: Page): Promise<void> {
  await page.evaluate(() => {
    const header = Array.from(document.querySelectorAll("button")).find((b) =>
      /^Done\s+\d+\+?$/.test(b.innerText.trim().replace(/\s+/g, " ")),
    );
    if (!header) throw new Error("no Done header");
    header.click();
  });
}

/** The last rendered conversation row's text — moves when a page lands past it. */
async function tailMarker(page: Page): Promise<string> {
  return (
    (await page
      .locator('[data-ui-owner^="ConversationItem"]')
      .last()
      .innerText()) ?? ""
  );
}

/** Scroll the last conversation into view, then let a page land. */
async function scrollToTail(page: Page): Promise<void> {
  await page
    .locator('[data-ui-owner^="ConversationItem"]')
    .last()
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
}

/** Tags the sidebar's scroll container: the scrollable ancestor of the rows. */
async function tagScroller(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    let el = document.querySelector(sel)?.parentElement ?? null;
    while (el !== null) {
      const s = getComputedStyle(el);
      if (
        /(auto|scroll)/.test(s.overflowY) &&
        el.scrollHeight > el.clientHeight
      )
        break;
      el = el.parentElement;
    }
    if (el === null) throw new Error("no scroll container above the rows");
    el.setAttribute("data-e2e-scroller", "");
  }, ROW);
}

interface DoneSample {
  /** The Done rows drawn, in DOM order (each outermost stamp once). */
  keys: string[];
  /** Keys drawn twice as separate rows (never a drag wrapper around its row). */
  duplicates: string[];
  /** Where the Done header is relative to the scroller: above, on or below screen. */
  header: "above" | "on" | "below" | "missing";
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The Done section's rows: the rows after its header and before the next section header. */
async function sampleDone(page: Page): Promise<DoneSample> {
  return page.evaluate(
    ({ sel, header }) => {
      const sc = document.querySelector<HTMLElement>("[data-e2e-scroller]")!;
      const re = new RegExp(header);
      const headers = [
        ...sc.querySelectorAll<HTMLElement>("button[aria-expanded]"),
      ].filter((b) => re.test(b.innerText.trim().replace(/\s+/g, " ")));
      const at = headers.findIndex((b) =>
        /^Done\s/.test(b.innerText.trim().replace(/\s+/g, " ")),
      );
      const box = sc.getBoundingClientRect();
      const base = {
        scrollTop: sc.scrollTop,
        scrollHeight: sc.scrollHeight,
        clientHeight: sc.clientHeight,
      };
      if (at < 0)
        return {
          ...base,
          keys: [],
          duplicates: [],
          header: "missing" as const,
        };
      const done = headers[at]!;
      const next = headers[at + 1];
      const follows = (a: Node, b: Node) =>
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const keys: string[] = [];
      const duplicates: string[] = [];
      const seen = new Set<string>();
      for (const row of sc.querySelectorAll(sel)) {
        if (!follows(done, row)) continue;
        if (next !== undefined && !follows(row, next)) continue;
        const k = row.getAttribute("data-row-key")!;
        // A drag wrapper around its own row stamps the key twice: count the
        // outermost only.
        if (row.parentElement?.closest(`[data-row-key="${CSS.escape(k)}"]`))
          continue;
        if (seen.has(k)) duplicates.push(k);
        seen.add(k);
        keys.push(k);
      }
      const r = done.getBoundingClientRect();
      const where =
        r.bottom <= box.top ? "above" : r.top >= box.bottom ? "below" : "on";
      return {
        ...base,
        keys,
        duplicates,
        header: where as DoneSample["header"],
      };
    },
    { sel: ROW, header: HEADER.source },
  );
}

/** Scrolls the sidebar by `px` and lets the page render two frames. */
async function scrollSidebar(page: Page, px: number): Promise<void> {
  await page.evaluate((d) => {
    const sc = document.querySelector<HTMLElement>("[data-e2e-scroller]")!;
    sc.scrollTop += d;
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, px);
  await page.waitForTimeout(400);
}

await withBrowser(async (h) => {
  const r = report("conversations queue — Done pages as you scroll");
  const { page, captured } = await h.session();

  await page.goto(pathUrl("agents"), { waitUntil: "domcontentloaded" });
  await page
    .locator('[data-ui-owner^="ConversationItem"]')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);

  const total = await doneCount(page);
  const initialTail = await tailMarker(page);
  r.note(`Done header: "${await doneHeader(page)}"`);
  r.ok(
    "the Done count is the exact total, not a lower bound",
    total > 30 && !(await doneHeader(page)).endsWith("+"),
    `got "${await doneHeader(page)}" (needs > 30 ended conversations)`,
  );

  await scrollToTail(page);
  await scrollToTail(page);
  const grownTail = await tailMarker(page);
  r.note(`after scrolling — header "${await doneHeader(page)}"`);
  r.ok(
    "scrolling to the tail pages more Done rows in",
    grownTail !== initialTail,
    `tail still "${grownTail}"`,
  );
  r.ok(
    "the exact count does not move as pages load",
    (await doneCount(page)) === total,
    `before ${total}, after ${await doneCount(page)}`,
  );
  await snap(page, OUT, "grown");

  // Collapse Done: the sentinel sits right under its header, in view.
  await toggleDone(page);
  await page.waitForTimeout(3000);
  const collapsedHeader = await doneHeader(page);
  await snap(page, OUT, "collapsed");
  r.note(`collapsed header: "${collapsedHeader}"`);
  // Expand again: nothing loaded while it was collapsed.
  await toggleDone(page);
  await page.waitForTimeout(500);
  const afterCollapse = await tailMarker(page);
  r.ok(
    "nothing pages in while Done is collapsed",
    afterCollapse === grownTail,
    `before "${grownTail}", after "${afterCollapse}"`,
  );

  // Leave Done and come back. Down first, a step under a screen at a time,
  // learning Done's rows in the order first seen.
  await tagScroller(page);
  const order: string[] = [];
  const index = new Map<string, number>();
  const learn = (keys: string[]) => {
    for (const k of keys) {
      if (index.has(k)) continue;
      index.set(k, order.length);
      order.push(k);
    }
  };
  const duplicates = new Set<string>();
  let s = await sampleDone(page);
  for (let i = 0; i < 400 && order.length < DEEP_ROWS; i++) {
    learn(s.keys);
    for (const k of s.duplicates) duplicates.add(k);
    const before = s.scrollTop;
    await scrollSidebar(page, Math.round(s.clientHeight * 0.6));
    s = await sampleDone(page);
    // At the bottom: wait for a page to land, else Done ended.
    if (s.scrollTop === before) {
      await page.waitForTimeout(1500);
      s = await sampleDone(page);
      if (s.scrollTop === before && s.scrollHeight - s.clientHeight <= before)
        break;
    }
  }
  learn(s.keys);
  const deepest = s.scrollTop;
  const countDeep = await doneCount(page);
  r.note(`deep: ${order.length} Done rows read, scrollTop ${deepest}`);
  await snap(page, OUT, "deep");

  // Up until the Done header is below the screen, then past one settle: the
  // viewport reports no Done row on screen, and its far pages are released.
  for (let i = 0; i < 400 && s.header !== "below" && s.scrollTop > 0; i++) {
    await scrollSidebar(page, -Math.round(s.clientHeight * 0.6));
    s = await sampleDone(page);
  }
  r.ok(
    "scrolled up until the Done header left the screen",
    s.header === "below",
    `header ${s.header} at scrollTop ${s.scrollTop}`,
  );
  await page.waitForTimeout(PAST_SETTLE_MS);
  const away = await sampleDone(page);
  r.note(`away: ${away.keys.length} Done rows still drawn`);
  await snap(page, OUT, "away");

  // Back down to where the deep scroll stopped: every Done row comes back,
  // once, in its order.
  const seenBack = new Set<string>();
  const backViolations: string[] = [];
  for (let i = 0; i < 400; i++) {
    let lastKnown = -1;
    for (const k of s.keys) {
      seenBack.add(k);
      const at = index.get(k);
      if (at === undefined) continue; // ended mid-run: new at Done's head
      if (at <= lastKnown) {
        backViolations.push(
          `row ${k} out of order at scrollTop ${s.scrollTop}`,
        );
        break;
      }
      lastKnown = at;
    }
    for (const k of s.duplicates) duplicates.add(k);
    if (s.scrollTop >= deepest) break;
    const before = s.scrollTop;
    await scrollSidebar(page, Math.round(s.clientHeight * 0.6));
    s = await sampleDone(page);
    if (s.scrollTop === before) {
      await page.waitForTimeout(1500);
      s = await sampleDone(page);
      if (s.scrollTop === before) break;
    }
  }
  await snap(page, OUT, "back");
  r.eq("coming back, Done's rows keep their order", backViolations, []);
  r.eq(
    "every Done row read on the way in is drawn again",
    order.filter((k) => !seenBack.has(k)).slice(0, 20),
    [],
  );
  r.eq("no Done row is ever drawn twice", [...duplicates].slice(0, 20), []);
  r.ok(
    "the Done count is unchanged by leaving and coming back",
    (await doneCount(page)) === countDeep && countDeep === total,
    `first ${total}, deep ${countDeep}, back ${await doneCount(page)}`,
  );

  // The hidden tail pages on: scrolling to it loads rows past it.
  const tailBefore = (await sampleDone(page)).keys.at(-1);
  await scrollToTail(page);
  await scrollToTail(page);
  const tailAfter = (await sampleDone(page)).keys.at(-1);
  r.ok(
    "loadMore after the tail was hidden still pages in rows past it",
    tailAfter !== undefined && tailAfter !== tailBefore,
    `tail "${tailBefore}" → "${tailAfter}" (Done may simply have ended)`,
  );

  const errors = [...captured.pageErrors, ...captured.consoleErrors];
  r.ok("no page or console errors", errors.length === 0, errors.join("\n"));
  await r.finish();
});
