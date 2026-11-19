import { useEffect } from "react";

/** The reader's own input: what WebKit itself counts as "the user took over". */
const READER_INPUT = ["touchstart", "wheel", "pointerdown", "keydown"] as const;

/**
 * Hand the scroll back to the reader once they act, when the browser is still
 * holding the page on a fragment's target.
 *
 * After a navigation to a fragment (`#id`, or a text fragment
 * `#:~:text=…`), WebKit keeps that target in view. After **every layout** it
 * reveals the target again (`LocalFrameView::scrollToAnchor` /
 * `scrollToPendingTextFragmentRange`, run from `performPostLayoutTasks`). That
 * goes on until the reader scrolls the *document*. The app never scrolls the
 * document: a pane scrolls its own inner scroller. iOS Safari scrolls an inner
 * scroller in the UI process, and that path never marks the frame as scrolled
 * by the user. So the hold never ends, and a page that lays out all the time (an
 * animated figure) pulls the reader back to the target on every frame. The
 * story page's text-fragment links "bounced" that way.
 *
 * WebKit ends the hold on a programmatic scroll of the frame
 * (`setScrollOffsetWithOptions` clears the anchor and cancels the pending text
 * fragment). Writing the scrolling element's own offset back is that scroll,
 * and it moves nothing. It runs on the reader's first input after a load or a
 * fragment change, never per event: the write forces a layout. Elsewhere it is
 * a no-op: Chrome and Firefox have no such hold.
 */
export function BrowserHoldRelease() {
  useEffect(() => {
    let armed = true;
    const release = () => {
      if (!armed) return;
      armed = false;
      const doc = document.scrollingElement;
      if (doc) doc.scrollTop = doc.scrollTop;
    };
    // A same-document fragment navigation takes a new hold.
    const rearm = () => {
      armed = true;
    };
    const opts = { capture: true, passive: true } as const;
    for (const type of READER_INPUT) addEventListener(type, release, opts);
    addEventListener("hashchange", rearm);
    return () => {
      for (const type of READER_INPUT) removeEventListener(type, release, opts);
      removeEventListener("hashchange", rearm);
    };
  }, []);
  return null;
}
