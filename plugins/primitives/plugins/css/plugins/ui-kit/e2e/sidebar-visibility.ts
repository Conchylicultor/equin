// Regression guard for the "sidebar tail clipped below the viewport" class of
// bug (see plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/sidebar.tsx).
//
// The app shell nests the sidebar inside an offset, transformed container, so
// any chrome above it (the app tab bar) shifts the sidebar down. If the sidebar
// is sized to the viewport (`h-svh`) instead of its container (`h-full`), it
// overshoots the bottom and silently clips its last nav item. This guard fails
// loudly when that happens — at a deliberately short viewport, which is the
// first place the tail falls off.
//
// Usage: bun plugins/primitives/plugins/css/plugins/ui-kit/e2e/sidebar-visibility.ts [--url <deploy>] [--width <px>] [--height <px>]
import {
  numArg,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { waitForNetworkIdle } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";

const URL = pathUrl("/agents");
// A short viewport is the stress case: the tail is the first thing to clip.
const VW = numArg("width", 1280);
const VH = numArg("height", 620);
const TOL = 2; // px; sub-pixel rounding slack.

const r = report();

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: VW, height: VH } });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdle(page);
  await page.waitForTimeout(2500);

  const result = await page.evaluate(
    ({ vh, tol }: { vh: number; tol: number }) => {
      const container = document.querySelector(
        '[data-slot="sidebar-container"]',
      );
      if (!container)
        return { ok: false, reason: "no sidebar-container found" };
      const cr = container.getBoundingClientRect();

      // 1) The sidebar must sit fully within the viewport — not overshoot the
      //    bottom (the h-svh-vs-h-full failure) nor start above the top.
      const overshoot = Math.round(cr.bottom - vh);
      const containerWithinViewport = cr.top >= -tol && cr.bottom <= vh + tol;

      // 2) Every *fixed* nav item (Tasks/Agents/Explorer/Stats…) must render
      //    fully inside the container's box. Items that live inside an internal
      //    scroll region (e.g. the Conversations queue list) are SUPPOSED to
      //    scroll past the container bottom, so exclude any button with a
      //    scrollable ancestor between it and the container.
      const isScrolled = (el: Element): boolean => {
        for (
          let p = el.parentElement;
          p && p !== container;
          p = p.parentElement
        ) {
          const oy = getComputedStyle(p).overflowY;
          if (oy === "auto" || oy === "scroll" || oy === "hidden") return true;
        }
        return false;
      };
      const items = [
        ...container.querySelectorAll('[data-slot="sidebar-menu-button"]'),
      ].filter((el) => !isScrolled(el));
      const clipped = items
        .map((el) => ({
          label: (el.textContent ?? "").trim().slice(0, 24),
          r: el.getBoundingClientRect(),
        }))
        .filter(
          ({ r: rect }) =>
            rect.height > 0 &&
            (rect.bottom > cr.bottom + tol || rect.top < cr.top - tol),
        )
        .map(({ label, r: rect }) => ({
          label,
          bottom: Math.round(rect.bottom),
        }));

      return {
        ok: containerWithinViewport && clipped.length === 0,
        overshoot,
        containerBottom: Math.round(cr.bottom),
        viewportBottom: vh,
        navItemCount: items.length,
        clipped,
      };
    },
    { vh: VH, tol: TOL },
  );

  console.log(`[sidebar-visibility] ${URL} @ ${VW}x${VH}`);
  console.log(JSON.stringify(result, null, 2));

  const overshoot = "overshoot" in result ? result.overshoot : undefined;
  const clipped = "clipped" in result ? result.clipped : undefined;
  r.ok(
    "sidebar fully visible; no nav items clipped",
    result.ok,
    `sidebar clipped (overshoot ${overshoot}px below viewport` +
      `${clipped?.length ? `, ${clipped.length} nav item(s) cut off: ${clipped.map((c) => c.label).join(", ")}` : ""}).`,
  );

  await r.finish();
});
