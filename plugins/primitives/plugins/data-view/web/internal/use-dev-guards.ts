import { useEffect, useRef } from "react";

const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);
const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent", ""]);

/**
 * Normalize any CSS color string to one canonical serialization, so two colors
 * authored differently (`oklch(0.92 0 48.72)` vs `oklch(0.92 0.00 48.72)`, an
 * `rgb()` vs an `#rrggbb`) compare equal iff they paint the same pixels. Both
 * inputs pass through the SAME `background-color` computed-value round-trip, so
 * equal colors yield an identical string and unequal colors differ. Returns
 * `null` when the value is not a color the UA can parse (the sentinel survives),
 * so the caller can skip rather than false-positive. Dev-only; one probe per call.
 */
function normalizeColor(value: string): string | null {
  const probe = document.createElement("span");
  const sentinel = "rgb(1, 2, 3)";
  probe.style.backgroundColor = sentinel;
  probe.style.backgroundColor = value.trim();
  document.body.appendChild(probe);
  const out = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return out === sentinel && value.trim() !== sentinel ? null : out;
}

/**
 * Dev-only structural guards for `<DataView>`, run once after layout settles.
 * Both fail loud but non-fatal (`console.error`, never throw — safe for
 * overlay/SSR edges).
 *
 * **(1) Single-scroll guard.** A DataView is always natural-height and never owns
 * a scroller, so its enclosing pane must provide exactly one scroll (a
 * `<PaneScroll>`). Find the nearest ancestor the content *vertically overflows*
 * and assert it is scrollable; if instead it clips (`overflow-y: hidden/visible`)
 * the pane forgot its `<PaneScroll>` and the view is unscrollable.
 *
 * Checking the first *vertically-overflowing* ancestor (not merely the first
 * `overflow-y:auto` one) is deliberate: a Miller layout's horizontal column
 * strip is `overflow-x:auto`, which forces computed `overflow-y:auto` even
 * though it never scrolls vertically — a naive overflow-style walk green-lights
 * it falsely. Anchoring on actual vertical overflow stops at the real culprit
 * and ignores the horizontal strip. With no vertical overflow yet (content still
 * loading) there is simply nothing to flag.
 *
 * **(1b) Unbounded-scroller guard.** The nearest scroll container is the
 * viewport the rows window against and the sticky headers pin to. One taller
 * than the scroller around it (a `<Scroll fill>` hung inside a pane's scroll
 * with no height-bounded column around it) never scrolls, so windowing mounts
 * every row. Compared against the enclosing scroller, never the window: a
 * Miller strip's forced `overflow-y` never reaches it.
 *
 * **(2) Chrome-mask match guard.** The sticky toolbar masks scrolled content with
 * `bg-chrome-mask` (→ `--chrome-mask`). For the pinned bar to read as a seamless
 * extension of its surface, `--chrome-mask` must equal the actual painted
 * background behind the DataView. A `<Surface>` (and the page canvas / sidebar /
 * theme scope) co-publishes `--chrome-mask` alongside its background, so this
 * always holds for surfaces built through the primitive. But an **ad-hoc**
 * surface — a raw `bg-muted`/`bg-card`/`bg-background` wrapper that bypasses
 * `<Surface>` — paints a background WITHOUT co-publishing, so the toolbar masks
 * with the inherited canvas color instead and a mismatched band appears. A lint
 * can't see this (the surface is a runtime ancestor, and `bg-muted`/`bg-background`
 * have no false-positive-free static fingerprint — they're also dividers, chips,
 * inputs, code blocks). This guard compares the REAL computed values, so it fires
 * exactly on the mismatch, wherever a DataView is dropped, with an actionable fix
 * (route the wrapper through `<Surface>`, which co-publishes).
 *
 * Lives in its own hook (not inline in the component) so the effect's ref read +
 * DOM walk stay out of the DataView component's React Compiler analysis — an
 * inline effect reading `ref.current` extends a mutable range that makes the
 * compiler skip optimizing the whole component (breaking its manual memos).
 *
 * Returns the ref to attach to the DataView root element.
 */
export function useDataViewDevGuards(label: string) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const root = ref.current;
    if (!root) return;
    // One frame for layout to settle before measuring overflow.
    const raf = requestAnimationFrame(() => {
      // (1) Single-scroll guard — first vertically-overflowing ancestor decides.
      let node = root.parentElement;
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight + 1) {
          if (!SCROLLABLE.has(getComputedStyle(node).overflowY)) {
            console.error(
              `[DataView ${label}] content overflows a non-scrolling ancestor — the pane must provide a <PaneScroll>`,
            );
          }
          break;
        }
        node = node.parentElement;
      }

      // (1b) Unbounded-scroller guard — the nearest scroll container is the
      // viewport the rows window against (`VirtualRows.findScrollParent`) and
      // the sticky headers pin to. Taller than the scroller around it, it
      // never scrolls: every row counts as on screen and is mounted, and no
      // header pins (the Pages tree column, report-1794951093-midl0z).
      const scrollers: HTMLElement[] = [];
      for (
        let n = root.parentElement;
        n && n !== document.body && scrollers.length < 2;
        n = n.parentElement
      ) {
        if (SCROLLABLE.has(getComputedStyle(n).overflowY)) scrollers.push(n);
      }
      const [inner, outer] = scrollers;
      if (inner && outer && inner.clientHeight > outer.clientHeight + 1) {
        console.error(
          `[DataView ${label}] its scroll container (${inner.clientHeight}px) is taller than the one around it (${outer.clientHeight}px), so it never scrolls — ` +
            `windowing mounts every row and sticky headers never pin. Bound it (a full-height column around a <Scroll fill>), or drop the inner scroller.`,
        );
      }

      // (2) Chrome-mask match guard — the toolbar's `--chrome-mask` vs the nearest
      // actually-painted surface behind it. The sticky toolbar is a descendant of
      // `root` with nothing setting `--chrome-mask` between them, so `root`'s
      // computed value is exactly what the bar paints.
      const mask = normalizeColor(
        getComputedStyle(root).getPropertyValue("--chrome-mask"),
      );
      if (mask) {
        let surface = root.parentElement;
        while (surface && surface !== document.documentElement) {
          const bg = getComputedStyle(surface).backgroundColor;
          if (!TRANSPARENT.has(bg)) {
            // First painted ancestor is the visual surface behind the toolbar.
            if (normalizeColor(bg) !== mask) {
              console.error(
                `[DataView ${label}] sticky toolbar mask (${mask}) ≠ surface background (${bg}) — ` +
                  `the enclosing surface paints a background without co-publishing --chrome-mask, ` +
                  `so the pinned toolbar shows a mismatched band. Route the wrapper through ` +
                  `<Surface> (@plugins/primitives/plugins/css/plugins/surface/web), which co-publishes it.`,
              );
            }
            break;
          }
          surface = surface.parentElement;
        }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [label]);
  return ref;
}
