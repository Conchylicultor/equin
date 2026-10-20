/**
 * Verifies the transcript's follow/restore behaviour against a REAL conversation
 * — the three defects that made "scroll to the bottom, refresh" land mid-way.
 *
 * Two things this script has to get right or it goes green while broken:
 *
 * 1. **The settle window.** Transcript rows keep growing after first paint
 *    (shiki resolves async, images load), so a measurement at network-idle
 *    reflects the *pre-highlight* layout — the very layout the old code scrolled
 *    to and was then stranded by. Every measurement here follows an explicit
 *    settle.
 * 2. **The right scroller.** The conversation route mounts several
 *    `[data-pane-scroll]` containers and the transcript is not reliably first in
 *    document order. A non-scrolling container reports `distanceToBottom: 0`
 *    forever, which reads as a pass on the assertion that matters most — so the
 *    scroller is located by the transcript rows it contains, never by position.
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/e2e/scroll-restore.ts --conv <id>
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { ElementHandle, Page } from "playwright";

const SETTLE_MS = 3000;
const JUMP = '[aria-label="Jump to bottom"]';

const convId = arg("conv") ?? "conv-1785419906-z31p";
const url = pathUrl(`/agents/c/${convId}`);

interface Metrics {
  top: number;
  distanceToBottom: number;
  topRowKey: string | null;
  scrollable: boolean;
}

/** Re-acquired per call: a reload invalidates any handle held across it. */
async function transcript(page: Page): Promise<ElementHandle<HTMLElement>> {
  const handle = await page.evaluateHandle(() => {
    const el = [...document.querySelectorAll("[data-pane-scroll]")].find((n) =>
      n.querySelector("[data-event-key]"),
    );
    if (!el) throw new Error("no [data-pane-scroll] contains transcript rows");
    return el as HTMLElement;
  });
  return handle.asElement() as ElementHandle<HTMLElement>;
}

async function measure(page: Page): Promise<Metrics> {
  const el = await transcript(page);
  return el.evaluate((scroller) => {
    const viewTop = scroller.getBoundingClientRect().top;
    let topRowKey: string | null = null;
    for (const row of scroller.querySelectorAll("[data-event-key]")) {
      if (row.getBoundingClientRect().bottom > viewTop) {
        topRowKey = row.getAttribute("data-event-key");
        break;
      }
    }
    return {
      top: scroller.scrollTop,
      distanceToBottom:
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      topRowKey,
      scrollable: scroller.scrollHeight > scroller.clientHeight + 10,
    };
  });
}

async function scrollUp(page: Page, by: number): Promise<void> {
  const el = await transcript(page);
  await el.evaluate((scroller, amount) => {
    scroller.scrollTop = Math.max(0, scroller.scrollTop - amount);
  }, by);
}

await withBrowser(async (h) => {
  const r = report("transcript scroll restore");
  const { page } = await h.session();

  await boot(page, url, { marker: "[data-event-key]", settleMs: SETTLE_MS });

  // A genuinely clean slate. Persistence outlives the browser context, so
  // without this the FIRST assertion silently measures a restore left behind by
  // the previous run — which passes or fails for reasons that have nothing to do
  // with the code under test.
  const cleared = await page.evaluate(() => {
    const doomed = Object.keys(localStorage).filter((k) =>
      k.startsWith("s:auto-scroll.positions:conversation-scroll:"),
    );
    for (const k of doomed) localStorage.removeItem(k);
    return doomed.length;
  });
  r.note(
    `cleared ${cleared} persisted scroll record(s) before the fresh-open check`,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-event-key]");
  await page.waitForTimeout(SETTLE_MS);

  // --- 1. a fresh open lands at the true bottom, AFTER late layout ----------
  const opened = await measure(page);
  r.note(
    `fresh open: distanceToBottom=${Math.round(opened.distanceToBottom)}px, ` +
      `scrollable=${opened.scrollable}`,
  );
  // Guard the whole run: every later assertion is vacuous on a transcript that
  // fits its viewport, and "always at the bottom" would pass all of them.
  r.ok(
    "the transcript is long enough to scroll (otherwise this run proves nothing)",
    opened.scrollable,
    "conversation is shorter than the viewport — pick a longer one with --conv",
  );
  r.ok(
    "a fresh open settles at the bottom once highlighting/images land",
    opened.distanceToBottom <= 50,
    `left ${Math.round(opened.distanceToBottom)}px short of the bottom — the ` +
      `pre-fix symptom (scrolled before async content grew the transcript)`,
  );

  // --- 2. scroll up, and stay put across a refresh --------------------------
  await scrollUp(page, 1500);
  await page.waitForTimeout(600); // > the persist debounce
  const parked = await measure(page);
  r.ok(
    "scrolling up parks the surface away from the bottom",
    parked.distanceToBottom > 50 && parked.topRowKey !== null,
    `distanceToBottom=${Math.round(parked.distanceToBottom)}, topRowKey=${parked.topRowKey}`,
  );
  r.note(`parked on row: ${parked.topRowKey}`);
  r.ok(
    "the jump-to-bottom off-ramp appears once parked",
    await page.isVisible(JUMP),
    "no jump-to-bottom button while away from the bottom",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-event-key]");
  await page.waitForTimeout(SETTLE_MS);
  const restored = await measure(page);
  r.note(`after refresh, top row: ${restored.topRowKey}`);
  r.ok(
    "a refresh restores the row that was on screen, not the bottom",
    restored.topRowKey === parked.topRowKey,
    `expected to land on ${parked.topRowKey} but landed on ${restored.topRowKey}`,
  );
  r.ok(
    "the restored position is genuinely not the bottom",
    restored.distanceToBottom > 50,
    "restored to the bottom — persistence did not take effect",
  );

  // --- 3. parked means parked: nothing may move it --------------------------
  const before = await measure(page);
  await page.waitForTimeout(2500);
  const after = await measure(page);
  r.ok(
    "the surface does not drift while parked",
    Math.abs(after.top - before.top) < 4,
    `scrollTop moved ${Math.round(after.top - before.top)}px with no user input`,
  );

  // --- 4. the off-ramp resumes following ------------------------------------
  await page.click(JUMP);
  // Wait on the real signal, not a guessed duration: the button unmounts exactly
  // when the surface resumes following, however long the smooth scroll takes.
  await page.waitForSelector(JUMP, { state: "hidden", timeout: 10_000 });
  await page.waitForTimeout(500); // let the smooth scroll land
  const jumped = await measure(page);
  r.ok(
    "jump-to-bottom returns to the bottom and resumes following",
    jumped.distanceToBottom <= 50,
    `still ${Math.round(jumped.distanceToBottom)}px from the bottom after jumping`,
  );

  // Following again ⇒ the next open must NOT restore the stale anchor.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-event-key]");
  await page.waitForTimeout(SETTLE_MS);
  const reopened = await measure(page);
  r.ok(
    "once following, a refresh lands at the bottom again",
    reopened.distanceToBottom <= 50,
    `restored to a stale anchor (${Math.round(reopened.distanceToBottom)}px from bottom) ` +
      `even though the surface was following when it unmounted`,
  );

  return await r.finish();
});
