import { useEffect, useState } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { FRAME_ACTIVITY_EVENT } from "@plugins/primitives/plugins/embed/plugins/frame/web";

/** How long the pointer rests before the presentation's chrome fades out. */
const IDLE_MS = 800;

/**
 * Activity that wakes the chrome: moving, pressing, scrolling, typing — and
 * the same inside a prototype's frame, which runs on its own origin, so its
 * input reaches us only as the frame's `FRAME_ACTIVITY_EVENT`.
 */
const ACTIVITY = [
  "pointermove",
  "pointerdown",
  "wheel",
  "keydown",
  FRAME_ACTIVITY_EVENT,
] as const;

/**
 * The chrome itself, as a target the pointer can rest on — the attribute every
 * piece of presentation chrome carries (`PRESENT_CHROME_ATTR`).
 */
export const PRESENT_CHROME_ATTR = "data-present-chrome";

/**
 * Chrome the user is using: hovered, or holding keyboard focus. Resting there
 * never counts as idle — only resting over the frame does, since it is the
 * frame the chrome would hide. (`:focus-visible`, not `:focus-within`: a click
 * leaves focus on the clicked button, which would keep the chrome up forever.)
 */
const IN_USE = `[${PRESENT_CHROME_ATTR}]:hover, [${PRESENT_CHROME_ATTR}]:has(:focus-visible)`;

/**
 * Whether the pointer has rested over `root` for a while — the video-player
 * rule, so the chrome floating over a presented frame gets out of the way of
 * what it covers once the user stops moving.
 *
 * The frame is a prototype document in an iframe, and pointer events inside an
 * iframe never reach its parent document. A prototype runs on its own origin
 * (the content host), so its activity arrives as the content frame's
 * `FRAME_ACTIVITY_EVENT`, bubbling to `root`. Besides `root`, every same-origin
 * document loaded under it is watched too, at any depth (the real app framed
 * as a source frame) — found on its `load` (captured at `root` and at every
 * watched document: `load` does not bubble, but it does pass through
 * ancestors' capture phase within one document), which also re-attaches when a
 * frame swaps or reloads its document.
 *
 * Never idle while `hold` (a popup opened from the chrome is showing) or while
 * the chrome is in use (`IN_USE`); the next activity re-arms the countdown.
 */
export function usePointerIdle(
  root: HTMLElement | null,
  hold: boolean,
): boolean {
  const [idle, setIdle] = useState(false);
  const holdRef = useLatestRef(hold);

  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (holdRef.current || root.querySelector(IN_USE)) return;
      setIdle(true);
    };
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(settle, IDLE_MS);
    };

    const targets = new Set<HTMLElement | Document>();
    // `contentDocument` is null for a cross-origin frame: nothing to watch.
    const watchFrame = (frame: HTMLIFrameElement) => {
      if (frame.contentDocument) listen(frame.contentDocument);
    };
    // Not `instanceof HTMLIFrameElement`: a nested frame's element belongs to
    // its own document's realm, whose constructor is not ours.
    const onLoad = (e: Event) => {
      const frame = e.target as Element | null;
      if (frame?.tagName === "IFRAME") watchFrame(frame as HTMLIFrameElement);
    };
    // Watches `target` and, recursively, every frame loaded under it.
    function listen(target: HTMLElement | Document) {
      if (targets.has(target)) return;
      targets.add(target);
      for (const type of ACTIVITY) {
        target.addEventListener(type, wake, { capture: true, passive: true });
      }
      target.addEventListener("load", onLoad, true);
      target.querySelectorAll("iframe").forEach(watchFrame);
    }

    listen(root);
    wake();
    return () => {
      clearTimeout(timer);
      for (const target of targets) {
        target.removeEventListener("load", onLoad, true);
        for (const type of ACTIVITY) {
          target.removeEventListener(type, wake, { capture: true });
        }
      }
    };
  }, [root, holdRef]);

  return idle;
}
