import { useCallback, useLayoutEffect, useState } from "react";
import { z } from "zod";
import {
  defineStore,
  useStore,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { listenForNavigation } from "./announce-navigation";

/**
 * This document. An offset saved under another one was saved before a reload
 * (or before the tab was restored); one saved under this one is an in-app
 * revisit, which opens at the top the way following a link does.
 */
const DOCUMENT_ID = crypto.randomUUID();

/**
 * Every kept scroller's last offset, one entry per key. Session storage: the
 * browser keeps it across a reload of the tab and drops it with the tab.
 */
const offsetStore = defineStore<{ top: number; doc: string }>({
  owner: "auto-scroll.reload-offsets",
  label: "Scroll positions across reload",
  area: "session",
  cap: "64 KB",
  ttl: 7 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.object({ top: z.number(), doc: z.string() }),
});

const SAVE_DEBOUNCE_MS = 150;

/** Switch the browser's scroll anchoring on `scroller` (`"none"` stands it down). */
function setAnchoring(scroller: HTMLElement, value: string): void {
  scroller.style.overflowAnchor = value;
}

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

/**
 * Keep a scroller's offset across a reload of the page: the browser's own
 * scroll restoration only knows the document's scroller, never an inner one,
 * and it gives up before async content has arrived anyway.
 *
 * Returns a callback ref for the scroller. `key` names what it shows, stable
 * across a reload (`undefined` keeps nothing). The offset is saved as the
 * reader scrolls (trailing debounce) and when the page hides; after a reload
 * it is put back as content arrives — every DOM change under the scroller
 * re-applies it (clamped, so a windowed list reaching its end loads
 * the next page and the restore carries on), with the browser's scroll
 * anchoring off, until the reader takes over (wheel, touch, a pointer down, a key pressed in it or a scroll
 * key, an announced navigation). A restore is a compensation, not a
 * navigation: it announces nothing.
 */
export function useScrollAcrossReload(
  key: string | undefined,
): (el: HTMLElement | null) => void {
  const store = useStore(offsetStore);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);

  useLayoutEffect(() => {
    if (!el || key === undefined) return;
    const saved = store.read(key);
    let target =
      saved.kind === "value" &&
      saved.value.doc !== DOCUMENT_ID &&
      saved.value.top > 0
        ? saved.value.top
        : null;

    const save = () => {
      // Mid-restore the saved target stands as written: a remount while the
      // page is still loading must find it again.
      if (target !== null) return;
      const top = el.scrollTop;
      if (top > 0) store.write(key, { top, doc: DOCUMENT_ID });
      else store.remove(key);
    };
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      save();
    };
    // Trailing-edge debounce, not a poll: a scroll emits events at input
    // frequency and each would otherwise be a storage write.
    const onScroll = () => {
      if (target !== null) return;
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    };

    // While a restore is pending, every DOM change under the scroller re-applies
    // it: content arriving is always a mutation, wherever it lands (a pane body
    // overflows from inside a full-height box, so no size observer on the
    // scroller's own children sees it grow). Observed only while pending.
    //
    // Reaching the offset does not end it: content above keeps settling after
    // it is first reachable (late blocks, highlighting), and the offset was read
    // off the SETTLED layout a reload reproduces. So the browser's scroll
    // anchoring stands down meanwhile — it would carry the reader along with
    // the half-built layout — and the offset is held until the reader acts.
    const arrivals = new MutationObserver(() => apply());
    const anchoring = el.style.overflowAnchor;
    const stopRestoring = () => {
      if (target === null) return;
      target = null;
      arrivals.disconnect();
      setAnchoring(el, anchoring);
    };
    const apply = () => {
      if (target === null) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const top = Math.min(target, max);
      if (el.scrollTop !== top) el.scrollTop = top;
    };
    // Any key the reader presses here is theirs to act on — a scroll key moves
    // the scroller, typing edits content that must not then be scrolled away.
    const onKeyDown = (e: KeyboardEvent) => {
      const inside = e.target instanceof Node && el.contains(e.target);
      if (inside || (e.target === document.body && SCROLL_KEYS.has(e.key)))
        stopRestoring();
    };

    if (target !== null) {
      setAnchoring(el, "none");
      arrivals.observe(el, { childList: true, subtree: true });
      apply();
    }
    const unlisten = listenForNavigation(el, stopRestoring);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", stopRestoring, { passive: true });
    el.addEventListener("touchstart", stopRestoring, { passive: true });
    el.addEventListener("pointerdown", stopRestoring);
    // eslint-disable-next-line shortcuts/no-window-key-listener -- observes, never handles: a key the reader presses in this scroller (or a scroll key on the body) ends the restore; nothing is prevented
    window.addEventListener("keydown", onKeyDown);
    // A reload unmounts nothing: the page hiding is the last chance to save.
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      stopRestoring();
      unlisten();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", stopRestoring);
      el.removeEventListener("touchstart", stopRestoring);
      el.removeEventListener("pointerdown", stopRestoring);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pagehide", flush);
    };
  }, [el, key, store]);

  return ref;
}
