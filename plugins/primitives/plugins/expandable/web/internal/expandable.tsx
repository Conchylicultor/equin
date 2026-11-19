import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { foldTiming } from "@plugins/primitives/plugins/collapsible/core";
import { prefersReducedMotion } from "@plugins/primitives/plugins/css/plugins/motion/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const keyboardArrowUpIcon = symbol("keyboard-arrow-up");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");

export interface ExpandableProps {
  /** The content to clamp. */
  children: ReactNode;
  /**
   * Collapsed clamp height in px. Content rendered taller than this is clipped
   * with a fade and gains a "Show more" toggle. Default 192 (= 12rem).
   */
  collapsedHeight?: number;
  /**
   * Controlled expanded state. When provided, the component is controlled: it
   * renders this value and never tracks its own — the owner must update it from
   * `onToggle`. When omitted, the component is uncontrolled and owns the state.
   */
  expanded?: boolean;
  /** Notified with the next expanded state whenever the user toggles. */
  onToggle?: (expanded: boolean) => void;
  /**
   * The toggle's two labels, for a host that names what is hidden ("Full
   * message"). Default "Show more" / "Show less".
   */
  labels?: { more: string; less: string };
  className?: string;
}

const DEFAULT_LABELS = { more: "Show more", less: "Show less" };

const FADE_MASK = "linear-gradient(to bottom, black 65%, transparent 100%)";

/**
 * Clamps tall content to `collapsedHeight` and reveals a Show more / Show less
 * toggle — but only when the content **actually overflows** that height.
 *
 * The decision is made by measuring the content's real rendered height with a
 * ResizeObserver (mirroring collapsible-wrap / adaptive-bar), NOT by
 * guessing from character or newline counts. That makes it correct regardless
 * of soft-wrapping, font size, viewport width, or async-loaded media: a long
 * single-paragraph prose block that wraps tall is collapsed just like one with
 * many hard line-breaks.
 *
 * The measured `contentRef` child is never height-constrained (the clamp lives
 * on its parent via `max-height` + `overflow:hidden`), so its `offsetHeight`
 * always reflects the full natural height in both collapsed and expanded
 * states — the overflow check never depends on the current state.
 */
export function Expandable({
  children,
  collapsedHeight = 192,
  expanded: expandedProp,
  onToggle,
  labels = DEFAULT_LABELS,
  className,
}: ExpandableProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  /** The clip's height when the reader toggled — where the fold starts. */
  const foldFrom = useRef<number | null>(null);
  const fold = useRef<Animation | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const isControlled = expandedProp !== undefined;
  const expanded = isControlled ? expandedProp : uncontrolledExpanded;

  // Overflow detection: ResizeObserver on the measured content box, deferred
  // via requestAnimationFrame. No timers, no polling. Fires again when async
  // media (images) load and grow the content.
  useResizeObserver(
    contentRef,
    () => {
      const content = contentRef.current;
      if (!content) return;
      setOverflowing(content.offsetHeight > collapsedHeight + 1);
    },
    { deps: [collapsedHeight] },
  );

  const clamped = overflowing && !expanded;
  const clipStyle: CSSProperties = clamped
    ? {
        maxHeight: collapsedHeight,
        overflow: "hidden",
        maskImage: FADE_MASK,
        WebkitMaskImage: FADE_MASK,
      }
    : {};

  // The toggle unfolds the clip to the content's height (or folds it back to
  // the clamp) on the app's one fold clock, instead of jumping. Only a toggle
  // moves it: an owner changing a controlled `expanded` on its own lands at
  // once. A toggle mid-fold starts from where the clip is.
  useLayoutEffect(() => {
    const from = foldFrom.current;
    const clip = clipRef.current;
    const content = contentRef.current;
    foldFrom.current = null;
    fold.current?.cancel();
    fold.current = null;
    if (from === null || !clip || !content) return;
    const to = expanded ? content.offsetHeight : collapsedHeight;
    if (Math.abs(to - from) < 1) return;
    const timing = foldTiming({ opening: expanded, distance: to - from });
    clip.style.overflow = "hidden";
    const anim = clip.animate(
      [{ maxHeight: `${from}px` }, { maxHeight: `${to}px` }],
      {
        duration: prefersReducedMotion() ? 0 : timing.duration,
        easing: timing.easing,
      },
    );
    // Expanded, the clip clips nothing once the fold is done; clamped, its
    // own style keeps `overflow: hidden`. Only the current fold settles: a
    // cancelled one's event lands after the next fold set its overflow.
    const settle = () => {
      if (fold.current !== anim) return;
      fold.current = null;
      if (expanded) clip.style.overflow = "";
    };
    anim.onfinish = settle;
    anim.oncancel = settle;
    fold.current = anim;
  }, [expanded, collapsedHeight]);

  const toggle = () => {
    const next = !expanded;
    if (clipRef.current)
      foldFrom.current = clipRef.current.getBoundingClientRect().height;
    if (!isControlled) setUncontrolledExpanded(next);
    onToggle?.(next);
  };

  return (
    <div className={className}>
      <div ref={clipRef} style={clipStyle}>
        <div ref={contentRef}>{children}</div>
      </div>
      {overflowing ? (
        <Inset t="xs">
          <button
            type="button"
            onClick={toggle}
            className="text-caption text-muted-foreground hover:text-foreground"
          >
            <Stack direction="row" gap="xs" align="center">
              {expanded ? (
                <>
                  <Icon icon={keyboardArrowUpIcon} className="size-3.5" />
                  {labels.less}
                </>
              ) : (
                <>
                  <Icon icon={keyboardArrowDownIcon} className="size-3.5" />
                  {labels.more}
                </>
              )}
            </Stack>
          </button>
        </Inset>
      ) : null}
    </div>
  );
}
