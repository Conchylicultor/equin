import { useLayoutEffect, useRef, useState } from "react";
import { cloneWithScroll } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import type { FloatingWindow } from "../hooks/use-floating-windows";

/** The live container of a window's shown tab (the surface host tags it). */
function windowElement(w: FloatingWindow): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-tab-id="${CSS.escape(w.activeTabId)}"]`,
  );
}

/**
 * Pin the window's resolved design tokens onto its clone. A window's tokens
 * come partly from the cascade: an app with no theme of its own inherits the
 * page's (`:root`) values through its ancestors. The clone is mounted inside
 * the desktop's chrome — another theme scope — so without this an inheriting
 * app would repaint in the desktop's palette (a dark window drawn light).
 * Copying every resolved custom property onto the clone's root makes it paint
 * exactly what the window paints, wherever it is mounted.
 */
function pinResolvedTokens(from: HTMLElement, to: HTMLElement): void {
  const computed = getComputedStyle(from);
  for (const prop of computed) {
    if (prop.startsWith("--"))
      to.style.setProperty(prop, computed.getPropertyValue(prop));
  }
}

/**
 * The window's layout size — untransformed (an opening window's scale, the
 * overview's, a minimise tween), and kept while it is hidden — or its stored
 * box when it was never laid out.
 */
function windowSize(
  w: FloatingWindow,
  el: HTMLElement,
): { w: number; h: number } {
  return el.offsetWidth > 0 && el.offsetHeight > 0
    ? { w: el.offsetWidth, h: el.offsetHeight }
    : { w: w.geo.w, h: w.geo.h };
}

/**
 * A still picture of a window, scaled to fit `maxW` × `maxH`: the part of its
 * container's DOM that shows, cloned at mount with its scroll offsets
 * (`cloneWithScroll` with `visibleOnly`), made inert and scaled down — the
 * shelf's hover thumbnails, the pager's desktop preview and the switcher all
 * draw one. Rebuilt on every mount, never kept: a snapshot is what the window
 * showed the moment it was asked for.
 *
 * Styling the copy is what a snapshot costs, element for element — the same
 * as restyling the window itself — so it copies only what can show: a Sonata
 * library window is ~4.3k elements, ~0.7k of them in view (~220 → ~40 ms of
 * style per snapshot). Canvases, iframes and media clone empty (their pixels
 * are not DOM, and a copy must not load anything); that is accepted.
 *
 * `fixedScale` draws it at that scale instead of fitting (the desktop preview,
 * where every window shares the desktop's one scale).
 */
export function WindowSnapshot({
  window: w,
  maxW,
  maxH,
  fixedScale,
}: {
  window: FloatingWindow;
  maxW: number;
  maxH: number;
  fixedScale?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number; s: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = windowElement(w);
    const target = host.current;
    if (!el || !target) return;
    const size = windowSize(w, el);
    const s = fixedScale ?? Math.min(maxW / size.w, maxH / size.h);
    const { clone, carryScroll } = cloneWithScroll(el, { visibleOnly: true });
    pinResolvedTokens(el, clone);
    clone.removeAttribute("data-tab-id");
    clone.setAttribute("inert", "");
    clone.setAttribute("aria-hidden", "true");
    Object.assign(clone.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${size.w}px`,
      height: `${size.h}px`,
      transform: `scale(${s})`,
      transformOrigin: "0 0",
      transition: "none",
      opacity: "1",
      // A hidden window (minimized, on another desktop, a background group
      // member) is hidden by the surface host's keep-alive style, which the
      // clone copies: undo it, or the picture is an empty box.
      contentVisibility: "visible",
      clipPath: "none",
      pointerEvents: "none",
    });
    target.replaceChildren(clone);
    carryScroll();
    setBox({ w: size.w, h: size.h, s });
    return () => target.replaceChildren();
    // A snapshot is taken once per mount by design (rebuilt on the next one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={host}
      // Names a window picture (the fullscreen-switch profile's peek probe).
      data-window-snapshot=""
      // eslint-disable-next-line layout/no-adhoc-layout -- a scaled clone's clip box: the clone is absolutely positioned and transformed, so the box is sized to the scaled window by hand
      className="relative overflow-hidden"
      style={
        box
          ? {
              width: Math.round(box.w * box.s),
              height: Math.round(box.h * box.s),
            }
          : { width: maxW, height: maxH }
      }
    />
  );
}
