import { useEffect, useState } from "react";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import {
  ContentFrame,
  FrameChannelClosedError,
  type FrameChannel,
} from "@plugins/primitives/plugins/embed/plugins/frame/web";
import type { ReadyContentUrl } from "@plugins/infra/plugins/endpoints/web";
import {
  MAX_PAGE_HEIGHT,
  probePageExtent,
  type PageExtent,
} from "../internal/page-extent";

/**
 * A prototype document in a content frame — on its own origin on the content
 * host, never the app's — laid out at the canvas's LOGICAL
 * size (so the page's own media queries run at that width) and shrunk or grown
 * on screen by `scale`.
 *
 * **A new `src` never blanks the frame.** A prototype renders client-side
 * (inline JSX through Babel), so a frame that navigates in place is empty from
 * the moment its new document commits until that document has rendered — a
 * visible flash on every version step, variant pick and live reload. So the new
 * document loads in a SECOND frame, hidden on top of the one on screen, and
 * replaces it on `load`. The frames are keyed by `src` and the incoming one is
 * always rendered after the one on screen, so promoting it only removes its
 * predecessor — React never moves the loaded frame's DOM node, which would
 * reload it.
 *
 * **A new `src` keeps the reader's place.** At the swap, every scroll offset of
 * the outgoing document is carried onto the incoming one (the content
 * channel's `captureScroll` / `restoreScroll`),
 * so an agent's edit reloading a live frame does not throw the reader back to
 * the top. What the page holds in script (an open menu, a typed value) is not
 * carried: that lives in the old document, and only a reload shows the edit.
 *
 * With `wholePage`, the document is first probed (`PageProbe`) for whether it
 * HAS a whole-page height. If it does, the frame is as tall as its own
 * document's content (reported by the channel's `watchHeight`); if the page sizes
 * itself to its window, the frame stays one screen tall. Either answer is
 * reported through `onPageExtent`, so the canvas can fit every frame to the
 * tallest page, and say when there is none. Otherwise the frame is one screen
 * tall and the page scrolls inside it.
 *
 * Whatever the mode, the document is told the height of one screen
 * (`SCREEN_HEIGHT_VAR`), and its color options are painted into it
 * (`colorVars`, as `--<name>` on its `<html>`) — on the document on screen as
 * they move, and on an incoming one before it is shown — so a color pick or a
 * drag never reloads the frame.
 *
 * Every read and write into the document is a request over its content
 * channel (`ContentFrame`'s `onChannel`): the document is on another origin.
 * What it answers is untrusted and only ever lays the frame out.
 */
export function PrototypeFrame({
  src,
  title,
  width,
  height,
  scale,
  wholePage,
  pageHeight,
  colorVars,
  onPageExtent,
}: {
  /** The document's URL, from `useFrameSrc` — never built here. */
  src: ReadyContentUrl;
  /** The frame's accessible name: the prototype's `<title>`, never its id. */
  title: string;
  width: number;
  height: number;
  scale: number;
  wholePage: boolean;
  /** This document's measured full height, when Whole page is on. */
  pageHeight: number | null;
  /** Each color option's color, `#rrggbb` by name (`useFrameColorVars`). */
  colorVars: Readonly<Record<string, string>>;
  onPageExtent: (extent: PageExtent) => void;
}) {
  // The document on screen. `src` differing from it means a new one is loading.
  const [shown, setShown] = useState(src);
  const frames = shown.url === src.url ? [src] : [shown, src];
  // The document on screen once it has loaded, and its channel.
  const [ready, setReady] = useState<{
    frame: HTMLIFrameElement;
    channel: FrameChannel;
  } | null>(null);
  const readyRef = useLatestRef(ready);
  // The probe's answer, for the document it probed. Whether a page follows
  // its window is a property of the document, so a new size never re-probes.
  const [probed, setProbed] = useState<{
    url: string;
    extent: PageExtent;
  } | null>(null);
  const extent = probed?.url === shown.url ? probed.extent : null;
  const hasPage = wholePage && extent?.kind === "page";
  const report = useEventCallback(onPageExtent);
  const heightRef = useLatestRef(height);

  // Whole page: the document's content height, as it changes.
  useEffect(() => {
    if (!ready || !hasPage) return;
    const { channel } = ready;
    const stop = channel.onHeight((h) =>
      report({
        kind: "page",
        height: Math.min(
          Math.max(h.contentHeight, heightRef.current),
          MAX_PAGE_HEIGHT,
        ),
      }),
    );
    void settled(channel.request({ op: "watchHeight" }));
    return () => {
      stop();
      void settled(channel.request({ op: "unwatchHeight" }));
    };
  }, [ready, hasPage, report, heightRef]);
  const docHeight = hasPage && pageHeight !== null ? pageHeight : height;

  useEffect(() => {
    if (ready) {
      void settled(
        ready.channel.request({ op: "setScreenHeight", px: height }),
      );
    }
  }, [ready, height]);

  // Only a property that differs is written (by the agent), so a re-render
  // that moved no color changes nothing on screen.
  const latestColors = useLatestRef(colorVars);
  useEffect(() => {
    if (ready) {
      void settled(ready.channel.request({ op: "setVars", vars: colorVars }));
    }
  }, [ready, colorVars]);

  // An incoming document is painted (screen height, colors) before it is
  // shown, and handed the outgoing one's scroll offsets once it is.
  const promote = async (
    frameSrc: ReadyContentUrl,
    frame: HTMLIFrameElement,
    channel: FrameChannel,
  ) => {
    await channel.request({ op: "setScreenHeight", px: heightRef.current });
    // Its url carries the colors as of when it was asked for; a drag may have
    // moved them since.
    await channel.request({ op: "setVars", vars: latestColors.current });
    const outgoing = readyRef.current;
    const scroll =
      outgoing === null
        ? []
        : await settled(outgoing.channel.request({ op: "captureScroll" }));
    setShown(frameSrc);
    setReady({ frame, channel });
    if (scroll !== null && scroll.length > 0) {
      await channel.request({ op: "restoreScroll", scroll });
    }
  };

  return (
    <div
      // The positioning context the incoming frame's layer covers; sized to
      // the scaled document so the scroll box around it knows its extent.
      className="relative"
      style={{
        width: width * scale,
        height: docHeight * scale,
        // The iframe keeps its unscaled layout box; clip it to the scaled one.
        overflow: "hidden",
      }}
    >
      {frames.map((frameSrc) => {
        const loading = frameSrc.url !== shown.url;
        return (
          <ContentFrame
            key={frameSrc.url}
            title={title}
            src={frameSrc}
            width={width}
            height={docHeight}
            // The incoming frame is invisible and out of the accessibility
            // tree until it has loaded; `load` then makes it the one shown.
            aria-hidden={loading || undefined}
            tabIndex={loading ? -1 : undefined}
            onChannel={(channel, frame) =>
              void settled(promote(frameSrc, frame, channel))
            }
            // The incoming frame is a layer over the one on screen, and drops
            // back into flow when promoted — a class change, never a remount.
            className={loading ? layerClasses() : undefined}
            style={{
              border: "0",
              display: "block",
              transform: `scale(${String(scale)})`,
              transformOrigin: "top left",
              visibility: loading ? "hidden" : "visible",
            }}
          />
        );
      })}
      {wholePage && extent === null ? (
        <PageProbe
          key={shown.url}
          src={shown}
          width={width}
          height={height}
          onExtent={(e) => {
            setProbed({ url: shown.url, extent: e });
            onPageExtent(e);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * A request whose frame may be replaced while it waits: a closed channel is
 * the frame's expected end (`null`), anything else fails loudly.
 */
async function settled<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof FrameChannelClosedError) return null;
    throw err;
  }
}

/**
 * A hidden twin of the document on screen, probed once for its extent
 * (`probePageExtent`), then unmounted. Laid over the frame at opacity 0, never
 * a hit target, rather than parked off-screen, so the browser keeps rendering
 * it.
 */
function PageProbe({
  src,
  width,
  height,
  onExtent,
}: {
  src: ReadyContentUrl;
  width: number;
  height: number;
  onExtent: (extent: PageExtent) => void;
}) {
  const [loaded, setLoaded] = useState<{
    frame: HTMLIFrameElement;
    channel: FrameChannel;
  } | null>(null);
  const report = useEventCallback(onExtent);
  // Read once the document has loaded: a later size does not restart the probe.
  const heightRef = useLatestRef(height);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void settled(
      probePageExtent(loaded.frame, loaded.channel, heightRef.current),
    ).then((extent) => {
      if (extent && !cancelled) report(extent);
    });
    return () => {
      cancelled = true;
    };
  }, [loaded, heightRef, report]);

  return (
    <ContentFrame
      src={src}
      title="Whole page probe"
      width={width}
      height={height}
      aria-hidden
      tabIndex={-1}
      onChannel={(channel, frame) => setLoaded({ frame, channel })}
      // Its own width and height win over the layer's inset: it lays out at
      // the logical size, like the frame on screen.
      className={layerClasses({ decorative: true })}
      style={{ border: "0", opacity: 0 }}
    />
  );
}
