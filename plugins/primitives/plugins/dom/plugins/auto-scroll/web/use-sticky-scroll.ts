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
import {
  followAction,
  isAtBottom,
  nextMode,
  resolveRestore,
  sentinelObserverOptions,
  type PersistedMode,
  type ScrollMode,
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
    z.object({ kind: z.literal("anchored"), key: z.string() }),
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
 * Stick-to-bottom streaming, as an *intent* the user sets rather than a state
 * the hook infers.
 *
 * The hook never guesses whether you want to be at the bottom. You are following
 * until a scroll it did not author lands you somewhere else; you are following
 * again when such a scroll lands you back at the bottom. Everything else — async
 * content settling, reflow, images loading, new messages arriving — only ever
 * *carries out* that standing intent.
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
  const sentinelVisibleRef = useRef(true);

  // What we last wrote, read back after the write so clamping is accounted for.
  // Any scroll landing anywhere else is, by definition, not ours.
  const lastWrittenTopRef = useRef<number | null>(null);

  const persistRef = useLatestRef(persist);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writeToBottom = useCallback((el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    lastWrittenTopRef.current = el.scrollTop;
  }, []);

  /** The topmost anchored row still on screen — resolved lazily, at persist time. */
  const currentAnchorKey = useCallback((): string | null => {
    const el = scrollRef.current;
    const cfg = persistRef.current;
    if (!el || !cfg) return null;
    const top = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>(`[${cfg.anchorAttr}]`);
    for (const row of rows) {
      if (row.getBoundingClientRect().bottom > top) {
        return row.getAttribute(cfg.anchorAttr);
      }
    }
    return null;
  }, []);

  const persistNow = useCallback(() => {
    const cfg = persistRef.current;
    if (!cfg) return;
    if (modeRef.current.kind === "following") {
      positionStore.write(cfg.key, { kind: "following" });
      return;
    }
    const key = currentAnchorKey();
    // Parked with nothing identifiable on screen (an empty or unanchored list):
    // leave whatever was stored alone rather than overwriting it with a guess.
    if (key === null) return;
    positionStore.write(cfg.key, { kind: "anchored", key });
  }, [currentAnchorKey]);

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
   */
  const applyAnchoring = useCallback((following: boolean) => {
    const el = scrollRef.current;
    if (el) el.style.overflowAnchor = following ? "none" : "auto";
  }, []);

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
      scrollChildIntoView(el, outcome.el, { block: "start" });
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
      sentinelVisibleRef.current = entry.isIntersecting;
      // The follow loop: while following, anything that moves the content end
      // off screen (a new message, an image loading, shiki resolving, a
      // reflow) pulls us back down. While parked, this is inert by
      // construction — see followAction.
      const el = scrollRef.current;
      if (
        el &&
        followAction(modeRef.current, entry.isIntersecting) ===
          "scroll-to-bottom"
      ) {
        writeToBottom(el);
      }
    },
    {
      root: scrollRef,
      ...sentinelObserverOptions(threshold),
      deps: [sentinelEl, threshold, writeToBottom],
    },
  );

  // ---- intent: "a scroll I did not author" ---------------------------------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let previousTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      const movedUp = top < previousTop;
      previousTop = top;
      if (top === lastWrittenTopRef.current) return; // ours
      // Read the geometry rather than the observer's last delivery: IO is async,
      // so its cached answer still describes the pre-scroll position and would
      // report "you scrolled to the bottom" for a scroll that just left it.
      // Writing it back also keeps the follow loop from acting on that stale
      // value before the observer catches up.
      const atBottom = isAtBottom(el, threshold);
      sentinelVisibleRef.current = atBottom;
      applyMode(
        nextMode({ t: "foreign-scroll", sentinelVisible: atBottom, movedUp }),
      );
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [applyMode, threshold]);

  // ---- explicit re-assertions ---------------------------------------------
  const followKeyFirstRunRef = useRef(true);
  useEffect(() => {
    if (followKeyFirstRunRef.current) {
      followKeyFirstRunRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    applyMode(nextMode({ t: "follow-key" }));
    writeToBottom(el);
  }, [followKey, applyMode, writeToBottom]);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    applyMode(nextMode({ t: "jump" }));
    // Instant, deliberately. A smooth scroll emits a stream of intermediate
    // offsets, none of which equal what we recorded as our own write — so the
    // hook's own "a scroll I did not author" test reads its own animation as the
    // user scrolling away and parks the surface mid-flight, cancelling the jump.
    // Owning the offset outright is the only version with no in-flight window,
    // and over a long transcript an instant jump is the better affordance
    // anyway.
    writeToBottom(el);
  }, [applyMode, writeToBottom]);

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
