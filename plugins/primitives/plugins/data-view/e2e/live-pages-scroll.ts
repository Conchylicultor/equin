/**
 * Scrolls a live, paged DataView deep and back, and checks the rows it shows
 * stay one continuous list (research/2026-10-09-global-live-key-range-pages-v2.md):
 *
 *  1. scrolling down a step at a time, every step's rows overlap the step
 *     before (no jump), keep the order already seen (no row reordered or
 *     inserted mid-list) and add new rows only below the last one seen, and
 *     the scroller settles where the step put it — nothing (a page released
 *     above into a placeholder, a row measured, scroll anchoring) moves it
 *     on its own;
 *  2. a page placeholder on screen resolves into rows (it is subscribed again
 *     once the viewport names it);
 *  3. the rows the DOM holds stay bounded however deep the read goes (the
 *     stale budget turns far pages into placeholders);
 *  4. scrolling back to the top a step at a time, the placeholders above
 *     landing as rows never move a row on screen, every row seen on the way
 *     down is seen again (steps under a screen), the order holds, and the
 *     head shows again;
 *  5. no row ever changes its x (its column, in a gallery or icons grid): a
 *     page released or landing above a grid keeps every card where it was
 *     drawn (the view's phase pad). A live insert at the read's head does
 *     reflow a grid's cards (a true reflow), so run a grid with no writes
 *     landing in its head mid-run.
 *
 * Read-only: it seeds nothing. Run against a deploy whose list holds 30+
 * pages (`--rows` is how many distinct rows to scroll through before
 * stopping; the end of the list stops it sooner). The page plan's own shape
 * is logged to `logs/live-pages.jsonl` of the deploy.
 *
 *   ./singularity run plugins/primitives/plugins/data-view/e2e/live-pages-scroll.ts \
 *     --path /agents/all-conversations [--rows 3200] [--step 0.4] [--expect <n>] [--out /tmp/live-pages] [--headed]
 *
 * `--view <type>` switches the surface to its first view of that type
 * (`gallery`, `list`, …) before anything is measured, through the switcher
 * chip's `data-view-type`. `--scroller <css>` names the scroll container
 * (default: the widest scrollable ancestor of the rows — pass it for a list
 * in a sidebar, e.g. Queue Done). `--width <px>` sets the viewport width (a
 * gallery's column count). `--expect-placeholders` fails the run when no
 * page placeholder was ever drawn (the read never released a page, so the
 * run proved nothing about releases).
 *
 * `--click <text>` clicks the control with that exact text first (a sidebar
 * entry opening a dialog — the Pages Trash), and waits for the rows inside
 * the `--scroller` it names.
 *
 * `--trace 1` records every write to the scroller's offset (with its stack),
 * every scroll event and every frame's layout around the window, and prints
 * them for a step that broke continuity.
 */
import { writeFileSync } from "node:fs";
import type { Page } from "playwright";
import {
  arg,
  boot,
  DEFAULT_VIEWPORT,
  flag,
  numArg,
  report,
  requirePage,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const PAGE = requirePage(
  "live-pages-scroll.ts --path <route> [--click <text>] [--view <type>] [--scroller <css>] [--width <px>] [--expect-placeholders] [--rows N] [--expect N] [--out <prefix>]",
);
const OUT = arg("out") ?? "/tmp/live-pages-scroll";
const TARGET_ROWS = numArg("rows", 3200);
const EXPECT = arg("expect");
const MAX_STEPS = numArg("max-steps", 2000);
/** Where to write the row keys in the order first seen (JSON), if anywhere. */
const DUMP = arg("dump");
/** How far one step scrolls, as a fraction of the viewport. */
const STEP = Number(arg("step") ?? "0.4");
/** How far a row on screen may move on its own during a step (sub-pixel rounding). */
const MAX_DRIFT_PX = 1;
/** The view type to switch to first, if any. */
const VIEW = arg("view");
/** The scroll container, if not the widest scrollable ancestor of the rows. */
const SCROLLER = arg("scroller");
const WIDTH = numArg("width", DEFAULT_VIEWPORT.width);
const EXPECT_PLACEHOLDERS = flag("expect-placeholders");
/** Text of a control to click before measuring (opens the surface under test). */
const CLICK = arg("click");

const ROW = "[data-row-key]:not([data-page-placeholder])";
/** `--trace`: record every write to the scroller's position with its stack. */
const TRACE = arg("trace") !== undefined;

interface Sample {
  scrollTop: number;
  scrollHeight: number;
  /** Every real row in the DOM, in DOM order. */
  dom: string[];
  /** The real rows intersecting the scroll container. */
  visible: string[];
  /** Placeholders intersecting the scroll container. */
  placeholdersInView: number;
  placeholders: number;
  /** Total height of the placeholders above the first visible row, px. */
  placeholderPxAbove: number;
  /** Every real row's left edge relative to the scroller, by key — its column. */
  lefts: Record<string, number>;
}

/**
 * Switches the surface to its first view of `type`: clicks that view's
 * switcher chip (unless it is already the active one — a click on the active
 * chip opens its settings) and waits for its rows.
 */
async function switchView(page: Page, type: string): Promise<void> {
  const chip = page.locator(`[data-view-type="${type}"]`).first();
  await chip.waitFor({ state: "visible", timeout: 30_000 });
  if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
  await page
    .locator(`[data-view-type="${type}"][aria-pressed="true"]`)
    .first()
    .waitFor({ timeout: 30_000 });
  await page
    .locator(ROW)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  // The new view's rows settle like the head did at boot.
  await page.waitForTimeout(1500);
}

/**
 * Clicks the control whose text is exactly `text` and waits for rows inside the
 * `--scroller` (required: the rows a click reveals sit beside the page's own).
 */
async function openSurface(page: Page, text: string): Promise<void> {
  if (SCROLLER === undefined) throw new Error("--click needs --scroller");
  await page.getByText(text, { exact: true }).first().click();
  await page
    .locator(`${SCROLLER} ${ROW}`)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1500);
}

/**
 * Tags the scroll container: `--scroller` when given, else of the scrollable
 * ancestors of every row, the widest — the page's main list, not a sidebar
 * list beside it.
 */
async function tagScroller(page: Page): Promise<void> {
  if (SCROLLER !== undefined) {
    await page.evaluate((css) => {
      const el = document.querySelector(css);
      if (el === null) throw new Error(`--scroller ${css} matches nothing`);
      el.setAttribute("data-e2e-scroller", "");
    }, SCROLLER);
    return;
  }
  await page.evaluate((sel) => {
    const scrollers = new Set<HTMLElement>();
    for (const row of document.querySelectorAll(sel)) {
      let el: HTMLElement | null = row.parentElement;
      while (el !== null) {
        const s = getComputedStyle(el);
        if (
          /(auto|scroll)/.test(s.overflowY) &&
          el.scrollHeight > el.clientHeight
        ) {
          scrollers.add(el);
          break;
        }
        el = el.parentElement;
      }
    }
    const widest = [...scrollers].sort(
      (a, b) => b.clientWidth - a.clientWidth,
    )[0];
    if (widest === undefined)
      throw new Error("no scroll container above the rows");
    widest.setAttribute("data-e2e-scroller", "");
  }, ROW);
}

async function sample(page: Page): Promise<Sample> {
  return page.evaluate((sel) => {
    const sc = document.querySelector<HTMLElement>("[data-e2e-scroller]")!;
    const box = sc.getBoundingClientRect();
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.bottom > box.top && r.top < box.bottom && r.height > 0;
    };
    // A row stamped twice (a drag wrapper around its row) counts once.
    const seen = new Set<string>();
    const rows = [...sc.querySelectorAll(sel)].filter((r) => {
      const k = r.getAttribute("data-row-key")!;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const phs = [...sc.querySelectorAll("[data-page-placeholder]")];
    const lefts: Record<string, number> = {};
    for (const r of rows) {
      lefts[r.getAttribute("data-row-key")!] =
        r.getBoundingClientRect().left - box.left;
    }
    return {
      lefts,
      scrollTop: sc.scrollTop,
      scrollHeight: sc.scrollHeight,
      dom: rows.map((r) => r.getAttribute("data-row-key")!),
      visible: rows.filter(inView).map((r) => r.getAttribute("data-row-key")!),
      placeholdersInView: phs.filter(inView).length,
      placeholders: phs.length,
      placeholderPxAbove: phs
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.bottom <= box.top)
        .reduce((sum, r) => sum + r.height, 0),
    };
  }, ROW);
}

/**
 * Waits until no placeholder is on screen, some row is, and the DOM holds
 * still: two samples in a row with the same offset and the same rows — a
 * sample taken before the window followed the scroll would learn the rows it
 * drew for the previous offset.
 */
async function settled(page: Page): Promise<Sample | null> {
  let last: Sample | null = null;
  const s = await waitFor(
    () => sample(page),
    (x) => {
      const still =
        last !== null &&
        last.scrollTop === x.scrollTop &&
        last.dom.join() === x.dom.join();
      last = x;
      return still && x.placeholdersInView === 0 && x.visible.length > 0;
    },
    { timeoutMs: 20_000, intervalMs: 150 },
  );
  return s.ok ? s.value : null;
}

/** Where a step started and landed, and the rows drawn the moment it scrolled. */
interface Step {
  /** The real rows in the DOM just before the write, in DOM order. */
  dom: string[];
  /** A row on screen just before the write, and its top relative to the scroller. */
  anchor: { key: string; top: number } | null;
  from: number;
  /** The offset the write landed on (clamped at the end of the content). */
  landed: number;
}

/** Scrolls by `frac` of the viewport. */
async function scrollBy(page: Page, frac: number): Promise<Step> {
  return page.evaluate(
    ({ f, sel }) => {
      const w = window as unknown as { __byScript?: boolean };
      const sc = document.querySelector<HTMLElement>("[data-e2e-scroller]")!;
      const box = sc.getBoundingClientRect();
      const rows = [...sc.querySelectorAll(sel)];
      const seen = new Set<string>();
      const dom = rows
        .map((r) => r.getAttribute("data-row-key")!)
        .filter((k) => !seen.has(k) && seen.add(k));
      // The anchor: the last row wholly on screen — a step of under a
      // screen leaves it on screen.
      const anchorEl = rows.findLast((r) => {
        const b = r.getBoundingClientRect();
        return b.top >= box.top && b.bottom <= box.bottom;
      });
      const anchor = anchorEl
        ? {
            key: anchorEl.getAttribute("data-row-key")!,
            top: anchorEl.getBoundingClientRect().top - box.top,
          }
        : null;
      const from = sc.scrollTop;
      w.__byScript = true;
      sc.scrollTop += Math.round(sc.clientHeight * f);
      w.__byScript = false;
      return { dom, anchor, from, landed: sc.scrollTop };
    },
    { f: frac, sel: ROW },
  );
}

/**
 * Lets the page render two frames — a programmatic scroll is reported (the
 * `scroll` event the window follows) at the next frame, and a sample taken
 * before it reads the window drawn for the previous offset.
 */
async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Where `key`'s row is now, relative to the scroller's top; `null` when not drawn. */
async function topOf(page: Page, key: string): Promise<number | null> {
  return page.evaluate((k) => {
    const sc = document.querySelector<HTMLElement>("[data-e2e-scroller]")!;
    const el = sc.querySelector(`[data-row-key="${CSS.escape(k)}"]`);
    return el === null
      ? null
      : el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  }, key);
}

async function installTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __byScript?: boolean; __trace: unknown[] };
    w.__trace = [];
    const sc = document.querySelector<HTMLElement>("[data-e2e-scroller]")!;
    const desc = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    )!;
    const stack = () =>
      (new Error().stack ?? "")
        .split("\n")
        .slice(2, 9)
        .map((l) => l.trim().slice(0, 140));
    const snapRows = () => {
      const box = sc.getBoundingClientRect();
      const phs = [
        ...sc.querySelectorAll<HTMLElement>("[data-page-placeholder]"),
      ];
      return {
        phs: phs.map((p) => [
          p.getAttribute("data-row-key"),
          Math.round(p.getBoundingClientRect().height),
        ]),
        firstVisible: [
          ...sc.querySelectorAll("[data-row-key]:not([data-page-placeholder])"),
        ]
          .find((r) => r.getBoundingClientRect().bottom > box.top)
          ?.getAttribute("data-row-key"),
        dom: sc.querySelectorAll("[data-row-key]:not([data-page-placeholder])")
          .length,
      };
    };
    Object.defineProperty(sc, "scrollTop", {
      configurable: true,
      get() {
        return desc.get!.call(this);
      },
      set(v: number) {
        const from = desc.get!.call(this) as number;
        desc.set!.call(this, v);
        w.__trace.push({
          t: performance.now(),
          kind: "set",
          by: w.__byScript ? "script" : "app",
          from,
          to: v,
          after: desc.get!.call(this),
          stack: w.__byScript ? [] : stack(),
          ...snapRows(),
        });
      },
    });
    for (const fn of ["scrollTo", "scrollBy"] as const) {
      const orig = sc[fn].bind(sc) as (...a: unknown[]) => void;
      (sc as unknown as Record<string, unknown>)[fn] = (...a: unknown[]) => {
        const from = sc.scrollTop;
        orig(...a);
        w.__trace.push({
          t: performance.now(),
          kind: fn,
          args: a,
          from,
          after: sc.scrollTop,
          stack: stack(),
          ...snapRows(),
        });
      };
    }
    // Per frame: what the layout around the window looks like.
    let prevSig = "";
    const frame = () => {
      const box = sc.getBoundingClientRect();
      const phs = [
        ...sc.querySelectorAll<HTMLElement>("[data-page-placeholder]"),
      ];
      const rows = [
        ...sc.querySelectorAll<HTMLElement>(
          "[data-row-key]:not([data-page-placeholder])",
        ),
      ];
      const first = rows[0];
      const vis = rows.find(
        (r) => r.getBoundingClientRect().bottom > box.top + 60,
      );
      const lead = first?.previousElementSibling as HTMLElement | null;
      const f = {
        st: sc.scrollTop,
        sh: sc.scrollHeight,
        nph: phs.length,
        phPx: Math.round(
          phs.reduce((a, p) => a + p.getBoundingClientRect().height, 0),
        ),
        firstRow: first?.getAttribute("data-row-key"),
        firstRowTop: first
          ? Math.round(
              first.getBoundingClientRect().top - box.top + sc.scrollTop,
            )
          : null,
        lead: lead ? Math.round(lead.getBoundingClientRect().height) : null,
        vis: vis?.getAttribute("data-row-key"),
        visTop: vis
          ? Math.round(vis.getBoundingClientRect().top - box.top)
          : null,
        dom: rows.length,
      };
      const sig = JSON.stringify(f);
      if (sig !== prevSig)
        w.__trace.push({
          t: performance.now(),
          kind: "frame",
          ...f,
          phs: [],
          dom: f.dom,
        });
      prevSig = sig;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    let last = sc.scrollTop;
    sc.addEventListener("scroll", () => {
      const now = sc.scrollTop;
      w.__trace.push({
        t: performance.now(),
        kind: "scroll-event",
        from: last,
        to: now,
        ...snapRows(),
      });
      last = now;
    });
  });
}

async function drainTrace(page: Page): Promise<unknown[]> {
  if (!TRACE) return [];
  return page.evaluate(() => {
    const w = window as unknown as { __trace: unknown[] };
    const out = w.__trace;
    w.__trace = [];
    return out;
  });
}

await withBrowser(async (h) => {
  const r = report(
    `live pages — deep scroll of ${new URL(PAGE).pathname}${VIEW ? ` (${VIEW})` : ""} at ${WIDTH}px`,
  );
  const { page } = await h.session({
    viewport: { width: WIDTH, height: DEFAULT_VIEWPORT.height },
  });
  await boot(page, PAGE, {
    marker: ROW,
    timeoutMs: 120_000,
    settleMs: 1500,
  });
  if (CLICK !== undefined) await openSurface(page, CLICK);
  if (VIEW !== undefined) await switchView(page, VIEW);
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });
  await tagScroller(page);
  if (TRACE) await installTrace(page);
  await snap(page, OUT, "0-head");

  const order: string[] = [];
  const index = new Map<string, number>();
  const learn = (keys: string[]) => {
    for (const k of keys) {
      if (index.has(k)) continue;
      index.set(k, order.length);
      order.push(k);
    }
  };

  const first = await settled(page);
  if (first === null) throw new Error("the head never settled");
  learn(first.dom);

  // 5. Every row's x, as first drawn: a row drawn again at another x moved
  // column — across a release or a landing above it, never on its own.
  const leftOf = new Map<string, number>();
  const columnShifts: string[] = [];
  let shifted = 0;
  const checkColumns = (where: string, x: Sample) => {
    for (const [k, left] of Object.entries(x.lefts)) {
      const was = leftOf.get(k);
      if (was !== undefined && Math.abs(was - left) > MAX_DRIFT_PX) {
        shifted++;
        if (columnShifts.length < 10) {
          columnShifts.push(
            `${where}: row ${k} moved from x ${Math.round(was)} to ${Math.round(left)} (placeholders ${x.placeholders})`,
          );
        }
      }
      leftOf.set(k, left);
    }
  };
  checkColumns("head", first);
  const headKeys = first.visible.slice(0, 5);

  const violations: string[] = [];
  /** Steps whose rows moved on their own, or that skipped rows. */
  let jumps = 0;
  let unresolvedPlaceholders = 0;
  let maxDom = first.dom.length;
  let maxPlaceholders = first.placeholders;
  let prev = first;
  const trace: unknown[] = [];
  let steps = 0;
  let stuck = 0;
  const shotAt = new Set([10, 50, 100]);

  while (order.length < TARGET_ROWS && steps < MAX_STEPS) {
    steps++;
    const step = await scrollBy(page, STEP);
    // The rows drawn when the step scrolled were seen — a page landing after
    // the last sample drew rows below it.
    learn(step.dom);
    await frames(page);
    const s = await settled(page);
    if (s === null) {
      unresolvedPlaceholders++;
      violations.push(`step ${steps}: a placeholder on screen never resolved`);
      await snap(page, OUT, `stuck-${steps}`);
      break;
    }
    // 1a. no jump: the row now at the top of the screen was already drawn
    // (a step scrolls less than the screen, and the rows below it are
    // drawn ahead) — else the scroll skipped rows nobody saw.
    const top = s.visible[0]!;
    const writes = await drainTrace(page);
    const before = violations.length;
    if (!index.has(top)) {
      jumps++;
      violations.push(
        `step ${steps}: jumped to unseen row ${top} (scrollTop ${prev.scrollTop}→${s.scrollTop}, height ${prev.scrollHeight}→${s.scrollHeight}, placeholders ${prev.placeholders}→${s.placeholders})`,
      );
    }
    // 1c. nothing but the step moved what is on screen: a row drawn before
    // the step sits exactly the step higher once the list settles — pages
    // released above the reader turn into placeholders of exactly their
    // rows' room, and a size the window learns above the reader is
    // compensated by the window itself.
    if (step.anchor !== null) {
      const now = await topOf(page, step.anchor.key);
      const expected = step.anchor.top - (step.landed - step.from);
      if (now !== null && Math.abs(now - expected) > MAX_DRIFT_PX) {
        jumps++;
        violations.push(
          `step ${steps}: the rows on screen moved ${Math.round(expected - now)}px on their own (scrollTop ${step.from}→${step.landed}→${s.scrollTop}, placeholders ${prev.placeholders}→${s.placeholders})`,
        );
      }
    }
    if (TRACE && violations.length > before) {
      console.log(`TRACE step ${steps}`, JSON.stringify(writes, null, 1));
    }
    // 1b. known rows keep their order; new rows only after every known one.
    let lastKnown = -1;
    let sawNew = false;
    for (const k of s.dom) {
      const i = index.get(k);
      if (i === undefined) {
        sawNew = true;
        continue;
      }
      if (sawNew) {
        violations.push(`step ${steps}: new row before known row ${k}`);
        break;
      }
      if (i <= lastKnown) {
        violations.push(`step ${steps}: row ${k} out of order`);
        break;
      }
      lastKnown = i;
    }
    learn(s.dom);
    checkColumns(`step ${steps}`, s);
    trace.push({
      step: steps,
      top: s.scrollTop,
      height: s.scrollHeight,
      placeholders: s.placeholders,
      placeholderPxAbove: Math.round(s.placeholderPxAbove),
      first: s.visible[0],
      dom: s.dom.length,
    });
    maxDom = Math.max(maxDom, s.dom.length);
    maxPlaceholders = Math.max(maxPlaceholders, s.placeholders);
    if (shotAt.has(steps)) await snap(page, OUT, `1-step-${steps}`);
    if (s.scrollTop === prev.scrollTop) {
      // At the bottom: wait for a page to append, else the list ended.
      if (++stuck >= 20) break;
      await page.waitForTimeout(250);
    } else {
      stuck = 0;
    }
    prev = s;
  }
  await snap(page, OUT, "2-deep");
  if (DUMP !== undefined) writeFileSync(DUMP, JSON.stringify({ order, trace }));
  console.log(
    `steps=${steps} distinct=${order.length} jumps=${jumps} maxDom=${maxDom} maxPlaceholders=${maxPlaceholders}`,
  );

  r.eq("no continuity violation while scrolling down", violations, []);
  r.eq("every placeholder on screen resolved", unresolvedPlaceholders, 0);
  r.ok(
    `scrolled through ${order.length} distinct rows (target ${TARGET_ROWS}${EXPECT ? `, expect ${EXPECT}` : ""})`,
    EXPECT ? order.length === Number(EXPECT) : order.length >= TARGET_ROWS,
  );
  r.ok(
    `the DOM held at most ${maxDom} rows (bounded well below ${order.length})`,
    maxDom < Math.min(order.length, 2000),
  );

  // 4. back to the top, a step at a time, through the placeholders the way
  // down left: every placeholder landing above the reader turns back into
  // its rows, and nothing on screen may move on its own while it does.
  const backViolations: string[] = [];
  const seenUp = new Set<string>((await settled(page))?.dom ?? []);
  let up = 0;
  for (;;) {
    up++;
    const step = await page.evaluate(
      ({ f, sel }) => {
        const sc = document.querySelector<HTMLElement>("[data-e2e-scroller]")!;
        const box = sc.getBoundingClientRect();
        // The anchor: the first row wholly on screen — a step up of under a
        // screen leaves it on screen.
        const anchorEl = [...sc.querySelectorAll(sel)].find((r) => {
          const b = r.getBoundingClientRect();
          return b.top >= box.top && b.bottom <= box.bottom;
        });
        const anchor = anchorEl
          ? {
              key: anchorEl.getAttribute("data-row-key")!,
              top: anchorEl.getBoundingClientRect().top - box.top,
            }
          : null;
        const from = sc.scrollTop;
        sc.scrollTop -= Math.round(sc.clientHeight * f);
        return { anchor, from, landed: sc.scrollTop };
      },
      { f: STEP, sel: ROW },
    );
    await frames(page);
    const s = await settled(page);
    if (s !== null && step.anchor !== null) {
      const now = await topOf(page, step.anchor.key);
      const expected = step.anchor.top + (step.from - step.landed);
      if (now !== null && Math.abs(now - expected) > MAX_DRIFT_PX) {
        backViolations.push(
          `up ${up}: the rows on screen moved ${Math.round(expected - now)}px on their own (scrollTop ${step.from}→${step.landed}→${s.scrollTop}, placeholders ${s.placeholders})`,
        );
      }
    }
    if (s !== null) {
      for (const k of s.dom) seenUp.add(k);
      maxDom = Math.max(maxDom, s.dom.length);
      maxPlaceholders = Math.max(maxPlaceholders, s.placeholders);
      checkColumns(`up ${up}`, s);
    }
    if (s === null) {
      backViolations.push(`up ${up}: a placeholder never resolved`);
      break;
    }
    let lastKnown = -1;
    for (const k of s.dom) {
      const i = index.get(k);
      if (i === undefined) continue;
      if (i <= lastKnown) {
        backViolations.push(`up ${up}: row ${k} out of order`);
        break;
      }
      lastKnown = i;
    }
    if (s.scrollTop === 0 || up > 2000) break;
  }
  const top = await waitFor(
    () => sample(page),
    (x) => headKeys.every((k, i) => x.visible[i] === k),
    { timeoutMs: 15_000 },
  );
  await snap(page, OUT, "3-back-at-top");
  console.log(`up steps=${up} distinctUp=${seenUp.size} maxDom=${maxDom}`);
  r.eq("no continuity violation scrolling back up", backViolations, []);
  if (STEP < 1) {
    r.eq(
      "every row seen on the way down was seen again on the way up",
      order.filter((k) => !seenUp.has(k)).slice(0, 20),
      [],
    );
  }
  r.ok(
    `the DOM held at most ${maxDom} rows both ways`,
    maxDom < Math.min(order.length, 2000),
  );
  r.eq(
    "the head shows again",
    top.value.visible.slice(0, headKeys.length),
    headKeys,
  );
  r.eq(`no row changed column (${shifted} moves)`, columnShifts, []);
  if (EXPECT_PLACEHOLDERS) {
    r.ok(
      `the read released pages into placeholders (at most ${maxPlaceholders} at once)`,
      maxPlaceholders > 0,
    );
  }
  r.ok(
    "the page never reloaded",
    await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    ),
  );
});
