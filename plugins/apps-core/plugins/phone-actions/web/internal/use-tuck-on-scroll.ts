import { useEffect, useState } from "react";

/** How long after the last scroll the button comes back (ms). */
const BACK_AFTER_MS = 900;

/**
 * Whether the button is tucked: true from the first scrolling gesture
 * anywhere on the page — a finger moving over it (`touchmove`) or a wheel —
 * until {@link BACK_AFTER_MS} after the last one. The user's gestures, not
 * `scroll` events: a pane that scrolls itself (a streaming transcript kept at
 * its end, a `scrollIntoView`) must not tuck the button. A drag of the button
 * itself is not one. The timer is a debounce of those events, not a poll. `untuck` brings it
 * back at once (a tap on the tab). `onTuck` runs as it tucks (the open menu
 * closes).
 */
export function useTuckOnScroll(onTuck: () => void): {
  tucked: boolean;
  untuck: () => void;
} {
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (e: Event) => {
      if (
        e.target instanceof Element &&
        e.target.closest("[data-phone-action-button]")
      )
        return;
      setTucked(true);
      onTuck();
      clearTimeout(timer);
      timer = setTimeout(() => setTucked(false), BACK_AFTER_MS);
    };
    const opts = { capture: true, passive: true };
    document.addEventListener("touchmove", onScroll, opts);
    document.addEventListener("wheel", onScroll, opts);
    return () => {
      document.removeEventListener("touchmove", onScroll, { capture: true });
      document.removeEventListener("wheel", onScroll, { capture: true });
      clearTimeout(timer);
    };
  }, [onTuck]);
  return { tucked, untuck: () => setTucked(false) };
}
