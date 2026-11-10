// Verifies that entering and leaving the solo (fullscreen) surface mode keeps
// every open tab ALIVE — the same DOM node, the same scroll position — and that
// the solo'd tab really does cover the whole window
// (research/2026-08-17-global-portal-is-not-keep-alive.md).
//
// Usage:
//   ./equin run plugins/apps-core/plugins/surface/e2e/solo-keepalive.ts \
//     [--url http://<worktree>.localhost:9000] [--out /tmp/solo-keepalive] [--headed]
//
// Why a DOM expando and not a screenshot: the old bug (a placement toggle that
// swapped the tab container for a portal) preserved every *pixel* and destroyed
// the mount, so the only way to see it is to mark the live node and ask for it
// back. A stamp that survives is proof React never deleted the subtree AND
// nobody re-parented the node underneath it.
//
// Assertions (PASS/FAIL logged per line, exit 1 on any failure):
//   1. entering fullscreen keeps the marked tab node and its scroll offset;
//   2. the solo'd container's rect IS the viewport (0,0 → innerWidth×innerHeight);
//   3. the container is still a descendant of the surface, never a body child;
//   4. docking again (the mode control) keeps the same node, stamp and scroll.

import type { Page } from "playwright";
import { pickSurfaceMode } from "./support/pick-surface-mode";
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/solo-keepalive");

const r = report();

/** The stamp we write onto the live tab node and expect to read back. */
const MARKER = `solo-keepalive-${Date.now()}`;

/**
 * The per-tab container the surface keeps mounted — the box whose class the
 * active placement swaps. `data-tab-id` is the only attribute that names ONE
 * tab's container: the app theme scope beside it is worn by the cross-app chrome
 * (the tab strip, the rail) too, and matching that instead measured the 33px tab
 * bar and called it a fullscreen tab. Only the focused tab is painted in docked
 * and solo, so the visible one is the tab under test.
 */
const TAB_SELECTOR = "[data-tab-id]";

/** What one in-page inspection of the live tab node reports back. */
interface TabProbe {
  /** False when no visible tab container was found at all. */
  found: boolean;
  /** The stamp read back off the node (undefined ⇒ a different node). */
  marker?: string;
  /** The marked scroller's offset, or -1 when nothing inside it scrolls. */
  scrollTop: number;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** True when the container still hangs under the surface, not under <body>. */
  insideSurface: boolean;
}

/** Stamp the live tab node (and its first real scroller) so we can re-find it. */
async function markTab(page: Page, marker: string): Promise<boolean> {
  return page.evaluate(
    ([selector, stamp]) => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(selector!),
      );
      const node = nodes.find((n) => getComputedStyle(n).display !== "none");
      if (!node) return false;
      const marked = node as HTMLElement & {
        __soloKeepAlive?: string;
        __soloKeepAliveScroller?: HTMLElement;
      };
      marked.__soloKeepAlive = stamp!;
      // Scroll something real inside the app, so the check covers DOM state a
      // re-parent would silently reset — not just React state.
      const scroller = Array.from(node.querySelectorAll<HTMLElement>("*")).find(
        (el) => el.scrollHeight > el.clientHeight + 40,
      );
      if (scroller) {
        scroller.scrollTop = 40;
        marked.__soloKeepAliveScroller = scroller;
      }
      return true;
    },
    [TAB_SELECTOR, marker],
  );
}

/** Read the live tab node back and describe it. */
async function probeTab(page: Page): Promise<TabProbe> {
  return page.evaluate((selector) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const node = nodes.find((n) => getComputedStyle(n).display !== "none");
    const empty = {
      found: false,
      scrollTop: -1,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      insideSurface: false,
    };
    if (!node) return empty;
    const marked = node as HTMLElement & {
      __soloKeepAlive?: string;
      __soloKeepAliveScroller?: HTMLElement;
    };
    const box = node.getBoundingClientRect();
    return {
      found: true,
      marker: marked.__soloKeepAlive,
      scrollTop: marked.__soloKeepAliveScroller?.scrollTop ?? -1,
      rect: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // The surface backdrop is the container's own ancestor chain; a tab that
      // was relocated to <body> would be a direct child of it instead.
      insideSurface: node.parentElement !== document.body,
    };
  }, TAB_SELECTOR);
}

/** True when the rect covers the whole window (±1px for fractional layout). */
function isFullViewport(p: TabProbe): boolean {
  return (
    Math.abs(p.rect.x) <= 1 &&
    Math.abs(p.rect.y) <= 1 &&
    Math.abs(p.rect.width - p.viewport.width) <= 1 &&
    Math.abs(p.rect.height - p.viewport.height) <= 1
  );
}

/** Wait until the SPA has painted something meaningful (a tab is shown). */
async function settle(page: Page, ms = 800): Promise<void> {
  await page
    .locator(TAB_SELECTOR)
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(ms);
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  await page.goto(pathUrl("/agents"));
  // Fullscreen is the boot mode: dock first, so there is a mode to leave.
  await page.locator('[data-ui-owner^="ViewOptionsButton@"]').waitFor();
  await pickSurfaceMode(page, "Dock in tab strip");
  await settle(page);

  const marked = await markTab(page, MARKER);
  r.ok("marked the live tab node", marked, marked ? MARKER : "no visible tab");

  const before = await probeTab(page);
  r.ok(
    "the mark reads back before the switch",
    before.marker === MARKER,
    String(before.marker),
  );
  r.ok(
    "the docked tab is NOT full-viewport",
    before.found && !isFullViewport(before),
    `${before.rect.width}x${before.rect.height} at ${before.rect.x},${before.rect.y}`,
  );
  await snap(page, out, "docked");

  // ---- Enter fullscreen ----------------------------------------------------
  await pickSurfaceMode(page, "Fullscreen (solo)");
  await page.waitForTimeout(600);

  const solo = await probeTab(page);
  r.ok("a tab is still painted in fullscreen", solo.found, String(solo.found));
  r.ok(
    "fullscreen kept the SAME tab node (mark survived)",
    solo.marker === MARKER,
    String(solo.marker),
  );
  r.ok(
    "fullscreen kept the inner scroll offset",
    solo.scrollTop === before.scrollTop,
    `${before.scrollTop} → ${solo.scrollTop}`,
  );
  r.ok(
    "the solo container fills the viewport",
    isFullViewport(solo),
    `${solo.rect.width}x${solo.rect.height} at ${solo.rect.x},${solo.rect.y} ` +
      `(viewport ${solo.viewport.width}x${solo.viewport.height})`,
  );
  r.ok(
    "the tab was never relocated to <body>",
    solo.insideSurface,
    String(solo.insideSurface),
  );
  await snap(page, out, "solo");

  // ---- Back to docked through the mode control (no Esc shortcut) ----------
  await pickSurfaceMode(page, "Dock in tab strip");
  await page.waitForTimeout(800);

  const after = await probeTab(page);
  r.ok(
    "leaving fullscreen kept the SAME tab node (mark survived)",
    after.marker === MARKER,
    String(after.marker),
  );
  r.ok(
    "leaving fullscreen kept the inner scroll offset",
    after.scrollTop === before.scrollTop,
    `${before.scrollTop} → ${after.scrollTop}`,
  );
  r.ok(
    "the tab is back inside the content area",
    after.found && !isFullViewport(after),
    `${after.rect.width}x${after.rect.height} at ${after.rect.x},${after.rect.y}`,
  );
  await snap(page, out, "back");

  await r.finish();
});
