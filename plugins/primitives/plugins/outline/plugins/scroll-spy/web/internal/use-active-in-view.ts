import { useEffect, useRef, useState } from "react";

import { findScrollParent } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import {
  createInViewWatcher,
  type InViewWatcher,
} from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";

/**
 * Where the "you are here" line sits inside the scroller. Shrinking the root box
 * from the bottom by two thirds leaves only the TOP THIRD counting as on screen —
 * roughly where a reader's eye is. Without it the highlight lags a whole section
 * behind, because a section still touching the viewport's bottom edge counts as
 * visible long after you have moved past it.
 *
 * It also pairs with the hold-last-value rule to give the Notion reading
 * semantics for free: while you are in the MIDDLE of a long section, its own
 * heading has scrolled above the band and the next one has not reached it, so
 * nothing is on screen and the previous answer stands.
 */
const READING_LINE_MARGIN = "0px 0px -66% 0px";

/** Which question the caller is asking about the reader. See {@link POSITIONS}. */
export type ReadingPosition = "reading-line" | "furthest-read";

/**
 * The band and the pick are ONE decision, not two knobs, so they are chosen
 * together by name. Widening the band while still taking the first id gives a
 * highlight that lags a section behind; narrowing it while taking the last gives
 * a watermark that forgets everything below the reading line.
 */
const POSITIONS = {
  // Notion-style: the section you are reading is the first one in the top third.
  "reading-line": { rootMargin: READING_LINE_MARGIN, pick: "first" },
  // A read watermark: the furthest row you have reached, anywhere on screen.
  "furthest-read": { rootMargin: undefined, pick: "last" },
} as const;

/**
 * Which of `ids` the reader is at, under one of two reading positions:
 *
 * - `"reading-line"` (the default) — the section being READ: the first id, in
 *   `ids` order, whose element sits in the top third of the scroller. This is
 *   what an outline highlights.
 * - `"furthest-read"` — how far the reader has GOT: the last id, in `ids` order,
 *   whose element is anywhere on screen. Everything above it has been scrolled
 *   past, so it is the point a running total can be reported "as of".
 *
 * Push-based by construction: elements report themselves through an in-view
 * watcher as they cross the band, so there is no scroll handler on the main
 * thread and nothing polls a position.
 *
 * The watcher is built ONCE and elements are enrolled incrementally as they
 * appear (rows mount and unmount as a streaming or virtualized surface scrolls) —
 * never rebuilt for new content. Rebuilding it per change (disconnect +
 * re-observe everything) would make each arriving row cost a full re-measure of
 * the whole document.
 *
 * `position` is the one exception, and it may change at runtime: the watcher is
 * retired and rebuilt when it does, because the band and the pick are fixed at
 * construction and cannot be renegotiated afterwards. The answer restarts from
 * the new position's first observation rather than carrying the old one over.
 *
 * Two rules that a hand-rolled copy reliably forgets, and that live here so that
 * no caller has to remember them:
 *
 * - **hold the last value when nothing is on screen** — an empty moment is a
 *   transient (mid-fling, a section taller than the band, a pane being torn
 *   down), not "the reader is nowhere". `null` is returned ONLY before the first
 *   observation lands, i.e. genuinely "not known yet";
 * - **enroll incrementally**, so a re-render never re-observes a node already
 *   watched. That one belongs to the watcher itself, which holds the `WeakSet`.
 *
 * The watcher `root` is DERIVED, not passed: the scroll parent of the first
 * element `resolve` returns. The entries live inside the scroller by
 * construction, so this is always right and the caller has one less prop to get
 * wrong.
 *
 * `resolve` returns `null` for an id whose element is not mounted (virtualized
 * or filtered away); that id is simply skipped and picked up on a later
 * enrollment pass.
 *
 * A host may report its sections BEFORE the surface renders them — every
 * consumer does — so "resolved nothing yet" is never terminal: a self-disarming
 * `MutationObserver` re-enrolls when the elements appear.
 *
 * Prefer a referentially stable `resolve` (a `useCallback`, or a module-level
 * function). An inline lambda is correct, just re-enrolls every render.
 */
export function useActiveInView(
  ids: string[],
  resolve: (id: string) => Element | null,
  options?: { position?: ReadingPosition },
): string | null {
  const [active, setActive] = useState<string | null>(null);
  const watcherRef = useRef<InViewWatcher | null>(null);
  // The scroller the watcher measures against: where later elements mount.
  const watcherRootRef = useRef<HTMLElement | null>(null);
  // The reverse of `resolve`, filled at enrollment: the watcher callback hands
  // back Elements, and the ids are opaque strings with no DOM contract of their
  // own (a caller may well have one; a generic primitive cannot assume it). A
  // WeakMap keeps a torn-out element collectable.
  const idOfRef = useRef<WeakMap<Element, string>>(new WeakMap());
  const onScreenRef = useRef<Set<string>>(new Set());
  // Which position the live watcher was BUILT for, so a later render can tell
  // that it is answering the wrong question. See the retirement below.
  const builtForRef = useRef<ReadingPosition | null>(null);
  // Read inside the watcher callback, which outlives the render that set it.
  const idsRef = useLatestRef(ids);
  const resolveLatest = useEventCallback(resolve);
  const position = options?.position ?? "reading-line";

  // Teardown belongs to the mount, not to an `ids` change: the watcher must
  // survive every re-enrollment pass below and die exactly once.
  useEffect(() => {
    return () => {
      watcherRef.current?.disconnect();
      watcherRef.current = null;
      watcherRootRef.current = null;
      builtForRef.current = null;
      idOfRef.current = new WeakMap();
      onScreenRef.current = new Set();
    };
  }, []);

  // The identity of `ids` churns every render at most call sites (an inline
  // `.map()`), so key the enrollment pass on its CONTENT instead.
  const idsKey = ids.join(" ");

  useEffect(() => {
    /**
     * One enrollment pass. Returns whether it is done: watching, with every id's
     * element enrolled — nothing left to retry.
     */
    const enroll = (): boolean => {
      const currentIds = idsRef.current;
      const onScreen = onScreenRef.current;
      const idOf = idOfRef.current;

      // An id that left the document can otherwise outlive its element here (a
      // torn-out node does not always report leaving the screen) and pin the
      // answer to a section that no longer exists.
      const known = new Set(currentIds);
      for (const id of onScreen) if (!known.has(id)) onScreen.delete(id);

      let watcher = watcherRef.current;
      // A position is not a setting the watcher can be told about later: the
      // band is baked into it at construction and `pick` is captured in its
      // callback, so one built for the other position would go on answering the
      // old question under the new name. Retire it and let the branch below
      // build the right one.
      if (watcher && builtForRef.current !== position) {
        watcher.disconnect();
        watcher = null;
        watcherRef.current = null;
        // Membership does not survive the switch: an id on screen anywhere in
        // the scroller may be nowhere near the reading line, and would
        // otherwise win the first pick after it.
        onScreen.clear();
      }

      if (!watcher) {
        const { rootMargin, pick } = POSITIONS[position];
        let first: HTMLElement | null = null;
        for (const id of currentIds) {
          const el = resolveLatest(id);
          if (el instanceof HTMLElement) {
            first = el;
            break;
          }
        }
        // Nothing mounted yet — there is no scroller to derive a root from. Not
        // a terminal state: the caller reports its sections before the surface
        // renders them, which is normal and must not cost the position forever.
        if (!first) return false;
        watcher = createInViewWatcher(
          (records) => {
            for (const record of records) {
              const id = idOf.get(record.target);
              if (id === undefined) continue;
              if (record.isIntersecting) onScreen.add(id);
              else onScreen.delete(id);
            }
            // `ids` order is the document order, so scanning it decides both
            // positions: stop at the first hit, or run to the last one.
            let picked: string | null = null;
            for (const id of idsRef.current) {
              if (!onScreen.has(id)) continue;
              picked = id;
              if (pick === "first") break;
            }
            setActive((prev) => picked ?? prev);
          },
          { root: findScrollParent(first), rootMargin },
        );
        watcherRef.current = watcher;
        watcherRootRef.current = findScrollParent(first);
        builtForRef.current = position;
      }

      let complete = true;
      for (const id of currentIds) {
        const el = resolveLatest(id);
        if (!el) {
          complete = false;
          continue;
        }
        idOf.set(el, id);
        // Cheap for an element already watched — the watcher owns that rule.
        // Its WeakSet is per-watcher, so a freshly built one re-observes every
        // element here rather than inheriting the retired watcher's enrollment.
        watcher.observe(el);
      }
      return complete;
    };

    if (enroll()) return;

    /**
     * Some sections exist but their elements do not yet — none at all (not
     * rendered yet), or only some (a surface that loads older content as the
     * reader scrolls up mounts its rows later). Watch for them until every one
     * has arrived, then enroll and stop watching.
     *
     * A retry is REQUIRED, and cannot be keyed on the caller's props. Hosts
     * routinely publish their outline before the surface that renders it: the
     * Pages editor mounts its rows a commit after `pageBlocks` resolves, and
     * the conversation publishes its scroll element from a callback ref. In both
     * cases `ids` is already final and `resolve` never changes identity, so a
     * props-keyed retry never fires — the rail paints its dashes and no section
     * is ever current. Treating "resolved nothing" as terminal is the absorbed
     * failure; this is the fix.
     *
     * Push-based and self-disarming (no polling): it costs one `resolve` per id
     * per mutation batch, only while some id is unmounted, and disconnects once
     * all are enrolled. Once a watcher exists the mutations watched are its
     * scroller's, not the whole document's.
     */
    if (idsRef.current.length === 0) return;
    const pending = new MutationObserver(() => {
      if (enroll()) pending.disconnect();
    });
    pending.observe(watcherRootRef.current ?? document.body, {
      childList: true,
      subtree: true,
    });
    return () => pending.disconnect();
  }, [idsKey, idsRef, resolveLatest, resolve, position]);

  return active;
}
