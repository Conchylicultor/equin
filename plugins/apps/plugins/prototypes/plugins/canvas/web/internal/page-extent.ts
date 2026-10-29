import type { FrameHeights } from "@plugins/primitives/plugins/embed/plugins/frame/plugins/agent/core";
import type { FrameChannel } from "@plugins/primitives/plugins/embed/plugins/frame/web";

/**
 * What Whole page can show of one prototype document: its full height, or
 * nothing, because the page sizes itself to its window.
 *
 * A page that sizes something from its window's height in script (a
 * `resize` handler reading `innerHeight`) has no whole-page height: the taller
 * the frame, the taller the page, without end. Whole page is then unavailable
 * for it, rather than a frame that grows forever.
 */
export type PageExtent =
  { kind: "page"; height: number } | { kind: "window-sized" };

/** The page height an extent shows — `null` for a window-sized page. */
export function pageHeightOf(
  extent: PageExtent | null | undefined,
): number | null {
  return extent?.kind === "page" ? extent.height : null;
}

/** Whether two extents say the same thing (a report that changes nothing). */
export function sameExtent(
  a: PageExtent | null | undefined,
  b: PageExtent,
): boolean {
  return a?.kind === b.kind && pageHeightOf(a) === pageHeightOf(b);
}

/**
 * The custom property every prototype frame's document is told the height of
 * ONE screen in (px), on its `<html>` — set by the content frame's agent
 * (`setScreenHeight`). With Whole page on the frame is as tall as the page, so
 * `100vh` and `innerHeight` are the page, not a screen; a prototype that sizes
 * something to the screen reads this instead (see `prototypes/CLAUDE.md`), and
 * so keeps a whole-page height.
 */
export const SCREEN_HEIGHT_VAR = "--prototype-screen-height";

/** The tallest a Whole page frame grows to — a guard, not a layout rule. */
export const MAX_PAGE_HEIGHT = 50_000;

/**
 * Probe a loaded document's extent in its own (hidden) frame, at one screen of
 * `screenH`, over its content channel — the document is on another origin, so
 * every read is a request and every answer is untrusted data.
 *
 * The page is measured at `screenH`, then its frame is doubled and its scripts
 * are given a few frames to react, then measured again. Its CONTENT height
 * (how far its content reaches, the frame's own height not counted) staying
 * put means the page has a height of its own; growing with the frame means it
 * follows its window — sized in script from `innerHeight`, or in CSS `vh` —
 * and has none. A page that fits one screen is one screen.
 *
 * A dedicated frame, never the one on screen: the doubling would show, and the
 * frame on screen already carries whatever its scripts wrote at its own size.
 */
export async function probePageExtent(
  frame: HTMLIFrameElement,
  channel: FrameChannel,
  screenH: number,
): Promise<PageExtent> {
  // One screen stays `screenH` while the frame is doubled: the doubling is
  // what tells a page that follows its window from one that does not.
  await channel.request({ op: "setScreenHeight", px: screenH });
  const atScreen = await measureAt(frame, channel, screenH);
  if (atScreen.contentHeight <= screenH + 1) {
    return { kind: "page", height: screenH };
  }
  await channel.request({ op: "dispatchResize" });
  const doubled = await measureAt(frame, channel, screenH * 2);
  frame.style.height = `${String(screenH)}px`;
  return doubled.contentHeight > atScreen.contentHeight + 1
    ? { kind: "window-sized" }
    : {
        kind: "page",
        height: Math.min(
          Math.max(atScreen.contentHeight, screenH),
          MAX_PAGE_HEIGHT,
        ),
      };
}

/** How many settles a frame resize is given to reach the document. */
const RESIZE_TRIES = 10;

/**
 * The document's heights once its frame is `height` tall: the resize reaches a
 * document on another origin asynchronously, so it is measured (after letting
 * its scripts react) until it sees the new height.
 */
async function measureAt(
  frame: HTMLIFrameElement,
  channel: FrameChannel,
  height: number,
): Promise<FrameHeights> {
  frame.style.height = `${String(height)}px`;
  for (let i = 0; i < RESIZE_TRIES; i++) {
    await channel.request({ op: "settle" });
    const heights = await channel.request({ op: "measure" });
    if (Math.abs(heights.innerHeight - height) <= 1) return heights;
  }
  throw new Error(
    `prototype extent probe: the frame never reached ${String(height)}px (its document still reads its own height as another) — is the frame hidden by display: none?`,
  );
}
