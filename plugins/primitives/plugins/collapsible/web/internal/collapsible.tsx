import {
  cn,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  useCollapsible,
  type CollapsibleWarmHandlers,
  type UseCollapsibleOptions,
} from "./use-collapsible";
import { foldTiming } from "../../core";
import { prefersReducedMotion, startFold } from "./fold-clock";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const chevronRightIcon = symbol("chevron-right");

export interface CollapsibleCtx {
  open: boolean;
  toggle: () => void;
  /** See `UseCollapsibleReturn.warm`: a trigger drives it through
   *  `warmHandlers`, and the content is mounted (hidden) while it holds. */
  warm: boolean;
  warmHandlers: CollapsibleWarmHandlers;
  contentId: string;
}

const CollapsibleContext = createContext<CollapsibleCtx | null>(null);

function useCtx() {
  const ctx = useContext(CollapsibleContext);
  if (!ctx)
    throw new Error(
      "Collapsible compound components must be used inside <Collapsible>",
    );
  return ctx;
}

/**
 * Reads the compound collapsible context WITHOUT throwing when absent.
 * Returns null outside a <Collapsible>. Lets context-aware components (e.g.
 * SectionHeaderRow) integrate with the compound pattern's open/toggle/aria
 * wiring while still working standalone. The raw Ctx stays private.
 */
export function useCollapsibleContext(): CollapsibleCtx | null {
  return useContext(CollapsibleContext);
}

export interface CollapsibleProviderProps extends UseCollapsibleOptions {
  children: ReactNode;
}

/**
 * The open/toggle/aria state of a collapsible, WITHOUT the wrapper element —
 * `Collapsible` minus its `<div>`. Reach for it when the trigger and the content
 * must be **siblings in the parent's own layout** rather than nested inside a box
 * of the collapsible's making: a subgrid row (a wrapper would displace the
 * `col-span-full` children out of the grid), or a sticky stack (a wrapper becomes
 * each header's containing block, so the header un-pins when its own section
 * scrolls away — exactly what a stack must not do). Everything else should use
 * `Collapsible`, whose `<div>` gives the group a real box and the `data-state`
 * hook.
 */
export function CollapsibleProvider({
  defaultOpen,
  open: controlledOpen,
  onOpenChange,
  children,
}: CollapsibleProviderProps) {
  const { open, toggle, warm, warmHandlers, contentId } = useCollapsible({
    defaultOpen,
    open: controlledOpen,
    onOpenChange,
  });

  const ctxValue = useMemo(
    () => ({ open, toggle, warm, warmHandlers, contentId }),
    [open, toggle, warm, warmHandlers, contentId],
  );

  return <CollapsibleContext value={ctxValue}>{children}</CollapsibleContext>;
}

export interface CollapsibleProps extends CollapsibleProviderProps {
  className?: string;
}

/** The standard collapsible: `CollapsibleProvider` plus the wrapper element that
 *  gives the group a box, a `data-state` styling hook, and (for a plain sticky
 *  header inside it) its own sticky containing block. */
export function Collapsible({
  className,
  children,
  ...options
}: CollapsibleProps) {
  return (
    <CollapsibleProvider {...options}>
      <CollapsibleBox className={className}>{children}</CollapsibleBox>
    </CollapsibleProvider>
  );
}

/** The wrapper `Collapsible` adds over the provider. Private: it reads the context
 *  the provider just published, so `data-state` stays on the same element it
 *  always was. */
function CollapsibleBox({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { open } = useCtx();
  return (
    <div
      data-slot="collapsible"
      data-state={open ? "open" : "closed"}
      className={className}
    >
      {children}
    </div>
  );
}

export interface CollapsibleTriggerProps extends ComponentProps<"button"> {}

export function CollapsibleTrigger({
  className,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: CollapsibleTriggerProps) {
  const { open, toggle, warmHandlers, contentId } = useCtx();

  return (
    // Line container: single-line by contract (the `region-line` root already
    // carries the structural `whitespace-nowrap`; this adds the leaf ellipsis layer).
    <SingleLineProvider value={true}>
      <button
        type="button"
        data-slot="collapsible-trigger"
        data-state={open ? "open" : "closed"}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
        onPointerEnter={(e) => {
          warmHandlers.onPointerEnter();
          onPointerEnter?.(e);
        }}
        onPointerLeave={(e) => {
          warmHandlers.onPointerLeave();
          onPointerLeave?.(e);
        }}
        onFocus={(e) => {
          warmHandlers.onFocus();
          onFocus?.(e);
        }}
        onBlur={(e) => {
          warmHandlers.onBlur();
          onBlur?.(e);
        }}
        // eslint-disable-next-line layout/no-adhoc-layout -- the trigger is a real <button> (needs type=button); Stack/Frame can't carry button-only attrs, so the flex row stays here
        className={cn("flex w-full region-line text-left", className)}
        {...props}
      />
    </SingleLineProvider>
  );
}

export interface CollapsibleContentProps extends ComponentProps<"div"> {}

/**
 * The content, while open — and, after a close, until its fold-away has run.
 *
 * The motion lives on a wrapper the primitive owns, never on the caller's box:
 * the caller's `className` (padding, a border, a rule) stays on the inner box,
 * so a fold tweens the whole of it down to nothing rather than stopping at its
 * padding and then jumping. Only a change of `open` after mount animates —
 * content that starts open appears as it always did, so a page full of open
 * sections does not unfold on load.
 */
export function CollapsibleContent({
  className,
  children,
  ...props
}: CollapsibleContentProps) {
  const { open, warm, contentId } = useCtx();
  return (
    <FoldMotion
      open={open}
      warm={warm}
      data-slot="collapsible-content"
      id={contentId}
      role="region"
    >
      <div className={className} {...props}>
        {children}
      </div>
    </FoldMotion>
  );
}

export interface FoldMotionProps extends ComponentProps<"div"> {
  /** Shown, or folded away. */
  open: boolean;
  /**
   * Keep the children mounted while closed (hidden, `display: none`), so an
   * unfold starts at once instead of after mounting them — `useCollapsible`'s
   * `warm`, held while the pointer rests on the trigger or focus is on it.
   * Default false: closed content is unmounted.
   */
  warm?: boolean;
}

/**
 * The fold itself, without the collapsible's state or semantics: a box that
 * holds its children while `open` and tweens their height and opacity when
 * `open` flips — kept mounted (and `inert`) after a close until its fold-away
 * has run, then unmounted. `CollapsibleContent` is this box plus the context's
 * open state, id and `region` role; reach for `FoldMotion` directly when the
 * open state lives elsewhere and the box carries no `region` — a tree node's
 * children, opened by the tree's own expand model.
 *
 * The props land on the moving box, so keep padding and borders on a box
 * INSIDE it: the tween clips this box, and anything on it would stop the fold
 * at its padding and then jump.
 */
export function FoldMotion({
  open,
  warm = false,
  children,
  ...props
}: FoldMotionProps) {
  const { ref, present } = useFoldMotion(open);
  // Warm and closed: the same element, so opening keeps the mounted children.
  if (!present && !warm) return null;
  return (
    <div
      {...props}
      ref={ref}
      data-state={open ? "open" : "closed"}
      // Warm and closed: mounted, laid out nowhere. Inline, so no class on
      // the box can out-rank it.
      style={present ? props.style : { ...props.style, display: "none" }}
      // Folding away: still painted, no longer there for focus or a reader.
      inert={!open}
    >
      {children}
    </div>
  );
}

/**
 * Tweens a box's height between 0 and its settled height when `open` flips,
 * keeping it mounted (`present`) until a close has finished. A flip mid-tween
 * starts from where the box is, so a quick double click reverses smoothly.
 * Under `prefers-reduced-motion` the tween has no duration — the same states,
 * no motion.
 *
 * The tween drives `max-height`, not `height`, and its far end is the box's
 * own measured size with the cap released — never `scrollHeight`. For a block
 * the two are the same motion. For a box its parent sizes — a `flex-1` body
 * sharing a column with its siblings — a `height` is overridden by the flex
 * basis and `scrollHeight` is the parent's allocation's inside, so only a cap
 * on the measured box folds it (and its siblings take the room back as it
 * goes).
 *
 * The tween starts on the first frame AFTER the commit, on the real clock.
 * Opening mounts the content, and mounting a long list of rows can hold the
 * main thread for hundreds of milliseconds. The browser dates an animation from
 * its frame clock, which was stamped before that work ran — so a tween created
 * in the commit (or even in the next frame's callback, whose stamp also
 * predates the long task) has already elapsed by the time anything paints, and
 * the content snaps open: the fold-away (whose content is already mounted)
 * animated, the unfold did not. So the commit only PINS the box at its first
 * frame (inline height + opacity, clipped); the tween starts on the next
 * animation frame (`startFold`, the clock every fold shares), measuring the
 * natural height there — after whatever the mount rendered — from
 * `performance.now()` rather than the stale frame stamp. A slow mount delays
 * the motion instead of swallowing it.
 */
function useFoldMotion(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  /** The tween in flight, and the box it runs on. */
  const running = useRef<{ anim: Animation; el: HTMLElement } | null>(null);
  /** The box is pinned at a tween's first frame, waiting for its start. */
  const pinned = useRef(false);
  const [present, setPresent] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  const [motion, setMotion] = useState<{ opening: boolean } | null>(null);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setPresent(true);
    setMotion({ opening: open });
  }

  useLayoutEffect(() => {
    const el = ref.current;
    if (motion === null || el === null) return;
    // Interrupted: start from the in-flight frame — a running tween's, or the
    // pinned first frame of one that has not started yet. Otherwise from the
    // far end. Only this box's own tween: a fold-away that unmounted its box
    // leaves its (held) animation on the detached node, which a reopen must not
    // start from.
    const prior = running.current?.el === el ? running.current.anim : null;
    const from =
      prior || pinned.current
        ? {
            height: el.getBoundingClientRect().height,
            opacity: Number(getComputedStyle(el).opacity),
          }
        : {
            height: motion.opening ? 0 : el.getBoundingClientRect().height,
            opacity: motion.opening ? 0 : 1,
          };
    prior?.cancel();
    running.current = null;
    el.style.overflow = "hidden";

    const start = (reduced: boolean, startTime: number) => {
      pinned.current = false;
      // Released first, so an unfold measures the size the box settles at.
      el.style.maxHeight = "";
      el.style.opacity = "";
      const to = motion.opening ? el.getBoundingClientRect().height : 0;
      const timing = foldTiming({
        opening: motion.opening,
        distance: to - from.height,
      });
      const anim = el.animate(
        [
          { maxHeight: `${from.height}px`, opacity: from.opacity },
          { maxHeight: `${to}px`, opacity: motion.opening ? 1 : 0 },
        ],
        {
          duration: reduced ? 0 : timing.duration,
          easing: timing.easing,
          // Backwards: a frame stamped before the start time below still
          // paints the first keyframe, never the unclipped box. A fold-away
          // also holds its last frame (height 0) until React unmounts the box.
          // Without it the animation's effect drops the moment it finishes, a
          // commit before the unmount lands, and the full content paints for
          // one frame between the collapse and its removal.
          fill: motion.opening ? "backwards" : "both",
        },
      );
      anim.startTime = startTime;
      running.current = { anim, el };
      anim.onfinish = () => {
        if (!motion.opening) {
          // Stays `running`: a reopen landing before the unmount must cancel
          // this held frame, and starts from it (height 0).
          setPresent(false);
          return;
        }
        running.current = null;
        // Settled open: natural height again, and nothing clipped (a sticky
        // header or a spilling popover inside must not be cut by the fold).
        el.style.overflow = "";
      };
    };

    // No motion wanted: nothing to protect from a slow commit, and pinning
    // would paint one empty frame for nothing.
    if (prefersReducedMotion()) {
      start(true, performance.now());
      return;
    }
    // Pin the first frame now (before paint), start the tween next frame.
    el.style.maxHeight = `${from.height}px`;
    el.style.opacity = String(from.opacity);
    pinned.current = true;
    // A flip before the start re-runs this from the pinned frame; an unmount
    // drops the box with it.
    return startFold((startTime) => start(false, startTime));
  }, [motion]);

  return { ref, present };
}

export interface CollapsibleChevronProps {
  open?: boolean;
  className?: string;
}

export function CollapsibleChevron({
  open: openProp,
  className,
}: CollapsibleChevronProps) {
  const ctx = useContext(CollapsibleContext);
  const open = openProp ?? ctx?.open ?? false;

  return (
    <Icon
      icon={chevronRightIcon}
      // eslint-disable-next-line layout/no-adhoc-layout -- rigid chevron indicator placed in arbitrary trigger rows; must never shrink
      className={cn(
        "shrink-0 transition-transform duration-200",
        open && "rotate-90",
        className,
      )}
    />
  );
}
