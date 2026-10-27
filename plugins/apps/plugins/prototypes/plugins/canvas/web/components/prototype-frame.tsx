import { useEffect, useRef, useState } from "react";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import {
  captureDocumentScroll,
  restoreDocumentScroll,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { usePageHeight } from "../internal/use-page-height";
import { publishColorVars } from "../internal/color-vars";
import {
  probePageExtent,
  publishScreenHeight,
  type PageExtent,
} from "../internal/page-extent";

/**
 * A prototype document in a sandboxed iframe, laid out at the canvas's LOGICAL
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
 * the outgoing document is carried onto the incoming one
 * (`captureDocumentScroll` / `restoreDocumentScroll`, from auto-scroll),
 * so an agent's edit reloading a live frame does not throw the reader back to
 * the top. What the page holds in script (an open menu, a typed value) is not
 * carried: that lives in the old document, and only a reload shows the edit.
 *
 * With `wholePage`, the document is first probed (`PageProbe`) for whether it
 * HAS a whole-page height. If it does, the frame is as tall as its own document
 * (measured at the logical `height`, see `usePageHeight`); if the page sizes
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
  src: string;
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
  const [shownSrc, setShownSrc] = useState(src);
  const frames = shownSrc === src ? [src] : [shownSrc, src];
  // The document on screen once it has loaded — what Whole page measures.
  const [ready, setReady] = useState<{
    frame: HTMLIFrameElement;
    doc: Document;
  } | null>(null);
  // The probe's answer, for the document it probed. Whether a page follows
  // its window is a property of the document, so a new size never re-probes.
  const [probed, setProbed] = useState<{
    src: string;
    extent: PageExtent;
  } | null>(null);
  const extent = probed?.src === shownSrc ? probed.extent : null;
  const hasPage = wholePage && extent?.kind === "page";
  usePageHeight(ready, height, hasPage, (h) =>
    onPageExtent({ kind: "page", height: h }),
  );
  const docHeight = hasPage && pageHeight !== null ? pageHeight : height;
  // The in-flight scroll restore into the document on screen, if any.
  const cancelRestore = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRestore.current?.(), []);

  useEffect(() => {
    if (ready) publishScreenHeight(ready.doc, height);
  }, [ready, height]);

  // Only a property that differs is written, so a re-render that moved no
  // color writes nothing.
  const latestColors = useLatestRef(colorVars);
  useEffect(() => {
    if (ready) publishColorVars(ready.doc, colorVars);
  }, [ready, colorVars]);

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
        const loading = frameSrc !== shownSrc;
        return (
          <iframe
            key={frameSrc}
            title={title}
            src={frameSrc}
            // allow-same-origin keeps the frame on our own origin, so a
            // prototype that fetch()es one of its own flat files works here
            // exactly as it does off disk. Safe: prototypes are first-party
            // files, authored on this machine and served from the user's own
            // ~/.equin/apps/prototypes/.
            sandbox="allow-scripts allow-same-origin"
            width={width}
            height={docHeight}
            // The incoming frame is invisible and out of the accessibility
            // tree until it has loaded; `load` then makes it the one shown.
            aria-hidden={loading || undefined}
            tabIndex={loading ? -1 : undefined}
            onLoad={(e) => {
              const frame = e.currentTarget;
              const doc = frame.contentDocument;
              // allow-same-origin (above) is what makes this readable.
              if (!doc) throw new Error("prototype frame is not same-origin");
              if (loading && ready) {
                cancelRestore.current?.();
                cancelRestore.current = restoreDocumentScroll(
                  doc,
                  captureDocumentScroll(ready.doc),
                );
              }
              // Its url carries the colors as of when it was asked for; a drag
              // may have moved them since. Painted before it is shown.
              publishColorVars(doc, latestColors.current);
              setShownSrc(frameSrc);
              setReady({ frame, doc });
            }}
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
          key={shownSrc}
          src={shownSrc}
          width={width}
          height={height}
          onExtent={(e) => {
            setProbed({ src: shownSrc, extent: e });
            onPageExtent(e);
          }}
        />
      ) : null}
    </div>
  );
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
  src: string;
  width: number;
  height: number;
  onExtent: (extent: PageExtent) => void;
}) {
  const [loaded, setLoaded] = useState<{
    frame: HTMLIFrameElement;
    doc: Document;
  } | null>(null);
  const report = useEventCallback(onExtent);
  // Read once the document has loaded: a later size does not restart the probe.
  const heightRef = useLatestRef(height);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void probePageExtent(
      loaded.frame,
      loaded.doc,
      heightRef.current,
      () => cancelled,
    ).then((extent) => {
      if (extent) report(extent);
    });
    return () => {
      cancelled = true;
    };
  }, [loaded, heightRef, report]);

  return (
    <iframe
      src={src}
      title="Whole page probe"
      sandbox="allow-scripts allow-same-origin"
      width={width}
      height={height}
      aria-hidden
      tabIndex={-1}
      onLoad={(e) => {
        const frame = e.currentTarget;
        const doc = frame.contentDocument;
        if (!doc) throw new Error("prototype probe frame is not same-origin");
        setLoaded({ frame, doc });
      }}
      // Its own width and height win over the layer's inset: it lays out at
      // the logical size, like the frame on screen.
      className={layerClasses({ decorative: true })}
      style={{ border: "0", opacity: 0 }}
    />
  );
}
