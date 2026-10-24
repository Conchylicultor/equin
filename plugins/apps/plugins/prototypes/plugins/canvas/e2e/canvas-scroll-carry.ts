// Verifies that a live frame keeps the reader's place across a reload: scroll
// frame A's document (the page itself, or its first scrollable panel when the
// page sizes itself to its window), rewrite the prototype's index.html with its
// own bytes (what an agent's edit looks like to the watcher), wait for the
// frame to swap in the new document, and check the new document is scrolled to
// the same offset. Needs a prototype taller than one screen (or with a
// scrollable panel) — pass --name.
// Manual only — nothing runs this automatically.
//
// Usage:
//   ./equin run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-scroll-carry.ts \
//     --name <prototype id> [--out <prefix>] [--headed]

import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { touchPrototype } from "@plugins/apps/plugins/prototypes/plugins/files/e2e";
import { openCanvas, pickPrototype, screen } from "./driver";

const out = arg("out", "/tmp/canvas-scroll-carry");
const meta = await pickPrototype();

/** Frame A's iframe on screen (not one still loading over it). */
function shownFrame(page: Page) {
  return screen(page, "A").locator("iframe:not([aria-hidden])");
}

/**
 * Scroll the first scrollable element of A's document — its scrolling element
 * first — to half its range. Returns its index in `querySelectorAll("*")` and
 * the offset, or `null` when nothing in the document scrolls.
 */
async function scrollSomething(
  page: Page,
): Promise<{ index: number; top: number } | null> {
  const frame = await (await shownFrame(page).elementHandle())?.contentFrame();
  if (!frame) throw new Error("frame A has no document");
  return frame.evaluate(() => {
    const all = [...document.querySelectorAll("*")];
    const root = document.scrollingElement;
    const candidates = root ? [root, ...all] : all;
    for (const el of candidates) {
      const range = el.scrollHeight - el.clientHeight;
      if (range < 40) continue;
      const style = getComputedStyle(el);
      if (el !== root && !/(auto|scroll)/.test(style.overflowY)) continue;
      el.scrollTop = Math.round(range / 2);
      return { index: all.indexOf(el), top: el.scrollTop };
    }
    return null;
  });
}

async function scrollOf(page: Page, index: number): Promise<number | null> {
  const handle = await shownFrame(page).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) return null;
  return frame.evaluate(
    (i) => document.querySelectorAll("*")[i]?.scrollTop ?? null,
    index,
  );
}

await withBrowser(async (h) => {
  const r = report(`canvas scroll carry — ${meta.title} (${meta.name})`);
  const { page, captured } = await h.session({
    viewport: { width: 1400, height: 900 },
  });
  await openCanvas(page, meta.name);
  await shownFrame(page).waitFor({ state: "attached", timeout: 15_000 });
  // A client-rendered page has nothing to scroll until its first render.
  const scrolled = await waitFor(
    () => scrollSomething(page),
    (v) => v !== null,
    { timeoutMs: 15_000 },
  );
  if (!scrolled.ok || scrolled.value === null) {
    r.fail("the prototype has something to scroll", meta.name);
    await r.finish();
  }
  const place = scrolled.value;
  if (place === null) return;
  const src0 = await shownFrame(page).getAttribute("src");
  await snap(page, out, "before");

  await touchPrototype(meta.name);
  const swapped = await waitFor(
    () => shownFrame(page).getAttribute("src"),
    (v) => v !== null && v !== src0,
    { timeoutMs: 15_000 },
  );
  r.ok(
    "the touch reloaded the frame (new src)",
    swapped.ok,
    `${String(src0)} → ${String(swapped.value)}`,
  );

  const kept = await waitFor(
    () => scrollOf(page, place.index),
    (v) => v !== null && Math.abs(v - place.top) <= 1,
    { timeoutMs: 8_000 },
  );
  await snap(page, out, "after");
  r.ok(
    "the reloaded document keeps the scroll offset",
    kept.ok,
    `before ${String(place.top)}, after ${String(kept.value)} (element #${String(place.index)})`,
  );
  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
