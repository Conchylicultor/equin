import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useInView } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { BottomSentinel } from "./internal/bottom-sentinel";
import { scrollChildIntoView } from "./scroll-child-into-view";
import { FOLLOW_MOTION_ATTR } from "./follow-motion";
import { findViewAnchor } from "./internal/view-anchor";
import { claimBottomPin, releaseBottomPin } from "./internal/bottom-pin";
import { listenForNavigation } from "./announce-navigation";
import {
  distanceToBottom,
  resolveRestore,
  sentinelObserverOptions,
  step,
  type PersistedMode,
  type ScrollMode,
  type StickySignal,
} from "./internal/sticky-scroll-machine";

/** Opt-in restoration of the reading position across reloads and remounts. */
export interface StickyScrollPersist {
  /**
   * Storage key. Must identify the *surface instance*, not just the entity —
   * two panes can be open on the same conversation, and they are allowed to be
   * scrolled to different places.
   */
  key: string;
  /**
   * Attribute stamped on candidate anchor rows, e.g. `"data-event-key"`.
   *
   * Its value must be **content identity**, never a list position. A positional
   * key silently re-points at a different row whenever anything filters,
   * prepends to or compacts the list.
   */
  anchorAttr: string;
  /**
   * Candidates inside an element carrying this attribute are saved only when
   * nothing else is on screen — content pinned with `position: sticky` (a
   * transcript's turn header) stays on screen through its whole section, so
   * saving it would restore to the section's start, not the row being read.
   * Same meaning as `KeepAnchorAcross`'s `weakAttr`.
   */
  weakAttr?: string;
}

export interface UseStickyScrollOptions {
  /** Distance from the bottom (px) still counted as "at the bottom". */
  threshold?: number;
  /**
   * Changing this re-asserts following — an explicit "the user just acted"
   * (they sent a turn), never an ambient state change. Do not wire it to
   * something like "an agent started working": a background agent resuming must
   * not yank a reading user to the bottom.
   */
  followKey?: number | string | boolean;
  persist?: StickyScrollPersist;
}

export interface StickyScrollHandle {
  /** Attach to the scrolling viewport (`overflow: auto`). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Render as the **last child** of that viewport. Misplacing it throws at
   * mount rather than silently degrading to "never follows".
   */
  bottomSentinel: ReactElement;
  /** True while the surface is chasing the bottom. */
  isFollowing: boolean;
  /** Jump to the bottom and resume following. */
  jumpToBottom: () => void;
}

const DEFAULT_THRESHOLD = 50;

/**
 * Every surface's saved reading position, one entry per `persist.key`. 30 days,
 * matching `pane-restore`. A cache: the oldest positions go first when full.
 */
const positionStore = defineStore<PersistedMode>({
  owner: "auto-scroll.positions",
  label: "Scroll positions",
  area: "local",
  cap: "256 KB",
  ttl: 30 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("following") }),
    z.object({
      kind: z.literal("anchored"),
      key: z.string(),
      offset: z.number().optional(),
    }),
  ]),
  // Written before the primitive as `singularity:draft:<persistKey>:<tab>`.
  // Positions are not worth carrying over: the old entries are only deleted.
  legacy: {
    match: (k) =>
      k.startsWith("singularity:draft:conversation-scroll:") ||
      k.startsWith("singularity:draft:subagent-scroll:"),
  },
});
const PERSIST_DEBOUNCE_MS = 150;

/**
 * How long after the reader's last input or scroll their scroll counts as
 * settled. A trailing debounce over input events, not a poll: momentum and
 * smooth scrolls keep emitting `scroll`, which keeps it open until they end.
 */
const SETTLE_MS = 150;

/** Keys that scroll the focused scroller (or the one under the last click). */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

/**
 * Stick-to-bottom streaming, as an *intent* the user sets rather than a state
 * the hook infers.
 *
 * You are following until YOU scroll away — reader input (wheel, touch, a
 * pointer down in the scroller, a scroll key) or a navigation you asked for
 * (`announceNavigation`, called by every sanctioned scroll funnel) — and your
 * scroll settles away from the bottom. Stopping within the threshold, or
 * coming back to it, follows again. Everything else — content settling,
 * reflow, images loading, new messages arriving, the browser clamping or
 * anchoring, a compensation keeping a row in place — only ever *carries out*
 * that standing intent: a scroll no reader input explains is put back at the
 * bottom.
 *
 * That inversion is what fixes the three defects the previous design had:
 * position was written before late layout settled, "am I at the bottom?" was
 * cached and only refreshed by scroll events (so it stayed wrong once content
 * grew), and consumers had to remember to call `scrollIfPinned()` from an effect
 * keyed on content length.
 *
 * See `internal/sticky-scroll-machine.ts` for the policy and the argument for
 * why this cannot reproduce the reflow bug that removed the old `ResizeObserver`.
 */
export function useStickyScroll(
  opts: UseStickyScrollOptions = {},
): StickyScrollHandle {
  const { threshold = DEFAULT_THRESHOLD, followKey, persist } = opts;

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The sentinel node lands in *state*, not a ref, via a callback ref. Two
  // reasons, and the second is the real one:
  //  - the effects that need it (the observer, the mount restore) can simply
  //    depend on it, instead of reading a ref and hoping about ordering;
  //  - `react-hooks/refs` rightly refuses to let anything ref-shaped be passed
  //    to a component during render, and a state setter is not ref-shaped.
  // The one extra render happens during commit, before paint, so nothing flashes.
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);

  // `mode` is the source of truth and lives in a ref: it is written from a
  // scroll listener and an IntersectionObserver, neither of which should cost a
  // render. Only the boolean projection is state, and only flips when following
  // actually changes — so scrolling around while parked re-renders nothing.
  const modeRef = useRef<ScrollMode>({ kind: "following" });
  const [isFollowing, setIsFollowing] = useState(true);

  // What we last wrote, read back after the write so clamping is accounted for.
  // Any scroll landing anywhere else is, by definition, not ours.
  const lastWrittenTopRef = useRef<number | null>(null);

  const persistRef = useLatestRef(persist);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writeToBottom = useCallback((el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    lastWrittenTopRef.current = el.scrollTop;
  }, []);

  const persistNow = useCallback(() => {
    const cfg = persistRef.current;
    if (!cfg) return;
    if (modeRef.current.kind === "following") {
      positionStore.write(cfg.key, { kind: "following" });
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    // The row being read — resolved lazily, here, never per scroll event.
    const viewTop = el.getBoundingClientRect().top;
    const anchor = findViewAnchor(el, viewTop, cfg.anchorAttr, cfg.weakAttr);
    // Parked with nothing identifiable on screen (an empty or unanchored list):
    // leave whatever was stored alone rather than overwriting it with a guess.
    if (anchor === null) return;
    positionStore.write(cfg.key, {
      kind: "anchored",
      key: anchor.name,
      offset: anchor.top - viewTop,
    });
  }, []);

  const schedulePersist = useCallback(() => {
    if (!persistRef.current) return;
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    // Trailing-edge debounce, not a poll: scrolling emits events at input
    // frequency and each one would otherwise be a localStorage write.
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }, [persistNow]);

  /**
   * Hand the position to whoever owns it.
   *
   * While following we own it, and the browser's scroll anchoring must stand
   * down: as rows above grow (shiki, images), anchoring holds the *reading*
   * position, which silently walks the surface away from the bottom and strands
   * the follow loop hundreds of px short. While parked the browser owns it, and
   * `auto` is exactly what keeps the user's row still through the same reflow —
   * for free, with no JS.
   *
   * The previous design had this toggle and was right to; its bug was that
   * "pinned" was a stale guess, so it disabled anchoring for readers too.
   *
   * The same toggle claims the bottom pin, which stands this plugin's own
   * anchoring (`KeepAnchorAcross`) down the same way — see `bottom-pin.ts`.
   */
  const applyAnchoring = useCallback(
    (following: boolean) => {
      const el = scrollRef.current;
      if (!el) return;
      el.style.overflowAnchor = following ? "none" : "auto";
      if (following) claimBottomPin(el, () => writeToBottom(el));
      else releaseBottomPin(el);
    },
    [writeToBottom],
  );

  const applyMode = useCallback(
    (next: ScrollMode) => {
      const wasFollowing = modeRef.current.kind === "following";
      modeRef.current = next;
      const nowFollowing = next.kind === "following";
      if (wasFollowing !== nowFollowing) {
        setIsFollowing(nowFollowing);
        applyAnchoring(nowFollowing);
      }
      schedulePersist();
    },
    [schedulePersist, applyAnchoring],
  );

  /** Feed the machine one signal and carry out what it says. */
  const dispatch = useCallback(
    (signal: StickySignal) => {
      const el = scrollRef.current;
      if (!el) return;
      const { mode, action } = step(modeRef.current, signal, threshold);
      if (mode.kind !== modeRef.current.kind) applyMode(mode);
      if (action === "scroll-to-bottom") writeToBottom(el);
    },
    [applyMode, threshold, writeToBottom],
  );

  // ---- mount: assert placement, then restore -------------------------------
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    // Waits for the sentinel to attach (one commit), then runs exactly once.
    if (restoredRef.current || !sentinelEl) return;
    const el = scrollRef.current;
    const sentinel = sentinelEl;
    // Fail loudly: a forgotten or misplaced sentinel would otherwise present as
    // "this surface just never follows", which is invisible in a consumer with
    // no jump-to-bottom affordance.
    if (!el) {
      throw new Error(
        "useStickyScroll: scrollRef must be attached to the scroll container. " +
          "Render {bottomSentinel} as the last child of that same element.",
      );
    }
    restoredRef.current = true;
    if (sentinel.parentElement !== el || sentinel !== el.lastElementChild) {
      throw new Error(
        "useStickyScroll: bottomSentinel must be the LAST child of the scroll " +
          "container. Anything rendered after it would sit below the bottom marker, " +
          "so the surface would stop following short of the true end.",
      );
    }

    const cfg = persistRef.current;
    const read = cfg ? positionStore.read(cfg.key) : null;
    const saved = read?.kind === "value" ? read.value : null;
    const outcome = resolveRestore(saved, (key) =>
      cfg
        ? el.querySelector<HTMLElement>(
            `[${cfg.anchorAttr}="${CSS.escape(key)}"]`,
          )
        : null,
    );

    if (outcome.kind === "anchored") {
      modeRef.current = { kind: "anchored" };
      setIsFollowing(false);
      applyAnchoring(false);
      if (outcome.offset === undefined) {
        scrollChildIntoView(el, outcome.el, { block: "start" });
      } else {
        // Put the row's top back exactly where it was on screen, so the view
        // (pinned headers included) is the one the reader left.
        const viewTop = el.getBoundingClientRect().top;
        el.scrollTop +=
          outcome.el.getBoundingClientRect().top - viewTop - outcome.offset;
      }
      lastWrittenTopRef.current = el.scrollTop;
      return;
    }
    if (outcome.kind === "missing" && cfg) {
      // The row this named is gone (filter set changed, transcript compacted, a
      // key-scheme change). Drop the stale record so it cannot keep failing, and
      // fall back to the bottom.
      positionStore.remove(cfg.key);
    }
    modeRef.current = { kind: "following" };
    setIsFollowing(true);
    applyAnchoring(true);
    writeToBottom(el);
    // Restore runs once per mount, guarded by restoredRef rather than by an
    // empty dep array. The pane remounts per conversation (PaneResolveGuard
    // keys on the route params), which is what makes a `resetKey` option
    // unnecessary.
  }, [sentinelEl, writeToBottom, persistRef, applyAnchoring]);

  // ---- the sensor ----------------------------------------------------------
  // The getter carries the "no scroll container, no sensor" guard the effect used
  // to spell out. Without it a missing container would resolve to a null root,
  // and the observer would silently measure against the viewport instead.
  useInView(
    () => (scrollRef.current && sentinelEl ? sentinelEl : null),
    (entry) => {
      // The follow loop: while following, anything that moves the content end
      // off screen (a new message, an image loading, shiki resolving, a
      // reflow) pulls us back down. Otherwise inert by construction — see
      // followAction.
      if (scrollRef.current)
        dispatch({ t: "sentinel", visible: entry.isIntersecting });
    },
    {
      root: scrollRef,
      ...sentinelObserverOptions(threshold),
      deps: [sentinelEl, threshold, dispatch],
    },
  );

  // ---- content in motion: follow it frame by frame -------------------------
  // The sentinel observer only fires once the content end has left its margin,
  // so content that GROWS over an animation would be caught up in steps. While
  // an element stamped FOLLOW_MOTION_ATTR animates, a following surface writes
  // the bottom on every frame instead. Event-driven: the frame loop exists
  // only between a stamped motion's start and its end.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !sentinelEl) return;
    const moving = new Set<Element>();
    let frame = 0;
    const tick = () => {
      // A row unmounted mid-animation never sends its end event.
      for (const target of moving)
        if (!target.isConnected) moving.delete(target);
      if (moving.size === 0) {
        frame = 0;
        return;
      }
      if (modeRef.current.kind === "following") writeToBottom(el);
      frame = requestAnimationFrame(tick);
    };
    const onStart = (e: Event) => {
      const target = e.target;
      if (
        !(target instanceof Element) ||
        !target.hasAttribute(FOLLOW_MOTION_ATTR)
      )
        return;
      moving.add(target);
      if (frame === 0) frame = requestAnimationFrame(tick);
    };
    const onEnd = (e: Event) => {
      if (e.target instanceof Element) moving.delete(e.target);
    };
    const starts = ["animationstart", "transitionrun"] as const;
    const ends = [
      "animationend",
      "animationcancel",
      "transitionend",
      "transitioncancel",
    ] as const;
    for (const type of starts) el.addEventListener(type, onStart);
    for (const type of ends) el.addEventListener(type, onEnd);
    return () => {
      for (const type of starts) el.removeEventListener(type, onStart);
      for (const type of ends) el.removeEventListener(type, onEnd);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [sentinelEl, writeToBottom]);

  // ---- intent: reader input arms, the reader's scroll settles -------------
  // Only an ARMED scroll — one that lands within SETTLE_MS of reader input or
  // an announced navigation — is the reader's; while driving, every scroll is.
  // Any other scroll is nobody's request and the machine puts a follower back
  // at the bottom. Settling (no input, no scroll for SETTLE_MS, the pointer
  // up) ends the window and lets the machine decide where the reader stopped.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !sentinelEl) return;
    let armed = false;
    let pointerDown = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let previousTop = el.scrollTop;
    // How far the bottom was at the reader's last scroll: what settle judges.
    let readerDistance = distanceToBottom(el);

    const settle = () => {
      timer = null;
      armed = false;
      dispatch({ t: "settle", distance: readerDistance });
    };
    const restartSettle = () => {
      if (timer !== null) clearTimeout(timer);
      timer = pointerDown ? null : setTimeout(settle, SETTLE_MS);
    };
    const arm = () => {
      armed = true;
      restartSettle();
    };

    const onScroll = () => {
      const top = el.scrollTop;
      const movedDown = top > previousTop;
      previousTop = top;
      const ours = top === lastWrittenTopRef.current;
      const distance = distanceToBottom(el);
      const reader = !ours && (armed || modeRef.current.kind === "driving");
      if (reader) {
        readerDistance = distance;
        restartSettle();
      }
      dispatch({ t: "scroll", ours, armed, movedDown, distance });
    };
    const onPointerDown = () => {
      pointerDown = true;
      arm();
    };
    const onPointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      if (armed) restartSettle();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        dispatch({ t: "find" });
        return;
      }
      if (!SCROLL_KEYS.has(e.key) || isEditable(e.target)) return;
      const target = e.target;
      if (
        target === document.body ||
        (target instanceof Node && el.contains(target))
      )
        arm();
    };

    const unlisten = listenForNavigation(el, arm);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", arm, { passive: true });
    el.addEventListener("touchstart", arm, { passive: true });
    el.addEventListener("touchmove", arm, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // eslint-disable-next-line shortcuts/no-window-key-listener -- observes, never handles: the browser performs the scroll (a scroll key) or the find (⌘F) and nothing is prevented; a scroll key arms only when its target is this scroller or the body, and find-in-page is page-wide by nature
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unlisten();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", arm);
      el.removeEventListener("touchstart", arm);
      el.removeEventListener("touchmove", arm);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      if (timer !== null) clearTimeout(timer);
    };
  }, [sentinelEl, dispatch]);

  // ---- explicit re-assertions ---------------------------------------------
  const followKeyFirstRunRef = useRef(true);
  useEffect(() => {
    if (followKeyFirstRunRef.current) {
      followKeyFirstRunRef.current = false;
      return;
    }
    dispatch({ t: "follow-key" });
  }, [followKey, dispatch]);

  // Instant, deliberately: own writes are told apart from the reader's by the
  // offset they leave, and a smooth scroll's intermediate offsets match none.
  const jumpToBottom = useCallback(() => dispatch({ t: "jump" }), [dispatch]);

  // ---- flush on unmount ----------------------------------------------------
  useEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistNow();
    };
  }, [persistNow]);

  const bottomSentinel = useMemo(
    () => createElement(BottomSentinel, { attach: setSentinelEl }),
    [],
  );

  return { scrollRef, bottomSentinel, isFollowing, jumpToBottom };
}
