import { flushSync } from "react-dom";
import { prefersReducedMotion } from "@plugins/primitives/plugins/css/plugins/motion/web";
import "./maximize-morph.css";

/**
 * Marks the box the demo is drawn in — framed and maximized alike — so a
 * Maximize or Restore can grow it into the other (`morphDemoFrame`). Spread
 * on the frame's element on both sides; only one is ever in the page.
 */
export const DEMO_FRAME_ATTR = "data-demo-frame";

const NAME = "demo-frame";
/** Scopes the morph's CSS to its own transition (`maximize-morph.css`). */
const ACTIVE_ATTR = "data-demo-morph";

let running = false;

/**
 * Run `update` — the switch between the framed demo and the maximized one —
 * as a view transition: the demo's box (`DEMO_FRAME_ATTR`) grows from the
 * frame to the tab's surface, or shrinks back, the rest of the page
 * cross-fading. The old side is a picture; `update` commits synchronously
 * inside the transition (`flushSync`), and the new box is matched by name.
 *
 * Where the browser has no view transitions, the visitor prefers reduced
 * motion or a morph is already running, `update` just runs.
 */
export function morphDemoFrame(update: () => void): void {
  if (
    running ||
    typeof document.startViewTransition !== "function" ||
    prefersReducedMotion()
  ) {
    update();
    return;
  }
  running = true;
  let named: HTMLElement | null = null;
  const nameFrame = (): void => {
    named = document.querySelector<HTMLElement>(`[${DEMO_FRAME_ATTR}]`);
    if (named !== null) named.style.viewTransitionName = NAME;
  };
  const clear = (): void => {
    if (named !== null) named.style.viewTransitionName = "";
    named = null;
  };
  nameFrame();
  document.documentElement.setAttribute(ACTIVE_ATTR, "");
  const transition = document.startViewTransition(() => {
    clear();
    flushSync(update);
    nameFrame();
  });
  const done = (): void => {
    clear();
    document.documentElement.removeAttribute(ACTIVE_ATTR);
    running = false;
  };
  // A transition the browser skips on its own (another one started, the page
  // hid) rejects `ready` with an AbortError: the update still ran. Anything
  // else (a throwing update) is ours, and surfaces here; `finished` rejects
  // with that same error, so it only cleans up.
  void transition.ready.catch((err: unknown) => {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw err;
  });
  void transition.finished.then(done, done);
}
