import { useEffect, useRef } from "react";
import { findScrollParent } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import "./website-scroll-cue.css";

/**
 * The scroll cue at the foot of a page's first screen: a V that arrives just
 * after the page has painted, bobs gently, scrolls to `target` when clicked,
 * and leaves at the first scroll of the pane.
 *
 * One component so every drawn page invites the first scroll the same way, at
 * the same moment. The page places it (`className`) and may tint it through
 * custom properties on itself or an ancestor: `--website-scroll-cue-ink` (the
 * V, the muted foreground by default), `--website-scroll-cue-hover` (the V
 * under the pointer, the foreground) and `--website-scroll-cue-glow` (its
 * halo, the primary).
 */
export function WebsiteScrollCue({
  label,
  target,
  align = "center",
  className,
}: {
  /** What a click does, for a screen reader ("Scroll to the first chapter"). */
  label: string;
  /**
   * Where a click scrolls to, found from the cue itself (`cue.closest(…)`), so a
   * page whose markup React renders once needs no ref. Read on click.
   */
  target: (cue: HTMLElement) => Element | null;
  /** Where the target lands in the pane: centred (a card), or at the top (a long section, under any `scroll-margin-top`). */
  align?: "center" | "start";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // gone at the first scroll, back when the pane returns to its top
  useEffect(() => {
    const cue = ref.current;
    if (!cue) return;
    const scroller = findScrollParent(cue);
    const onScroll = () =>
      cue.toggleAttribute("data-gone", scroller.scrollTop > 8);
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      className={`website-scroll-cue${className ? ` ${className}` : ""}`}
      aria-label={label}
      onClick={(e) =>
        revealElement(target(e.currentTarget), {
          behavior: "smooth",
          block: align,
        })
      }
    >
      <svg
        width="28"
        height="16"
        viewBox="0 0 28 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3 3l11 10L25 3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
