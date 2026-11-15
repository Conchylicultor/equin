import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  useViewportSize,
  type ViewportSize,
} from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
import {
  DemoControls,
  DemoTarget,
  useDemoActions,
  useDemoState,
} from "@plugins/apps/plugins/website/plugins/live-demo/web";
import "./live-demo-section.css";

const NO_WINDOW: ViewportSize = { width: 0, height: 0 };

const CAPTION = "equin, running entirely in your browser.";

/** The frame's aspect in the reading measure. */
const ASPECT = 16 / 9.4;
/** Grown, its distance from the window's edges (px). */
const GROWN_GAP = 24;
/** Grown, at most this wide (px): past it the demo is a desktop already. */
const GROWN_MAX_WIDTH = 1400;
/** Room kept under the grown frame for its caption row (px). */
const FOOT_ROOM = 56;

/**
 * The homepage's live demo, where the desktop picture was: equin itself —
 * its real server code in a worker, on the workspace demo's data — drawn in
 * a frame this band claims (`live-demo`'s `DemoTarget`; the demo's server is
 * the site's resident, so it outlives the page). Nothing downloads until the
 * visitor clicks Enter equin (the gate, shown on every visit; a browser that
 * already holds the demo's data starts it behind the gate, so entering is
 * instant).
 *
 * Entering grows the frame in place, for good: out of the reading measure,
 * nearly as wide and tall as the window, the page below moving down and
 * scrolling to it. Once it runs, the row under it offers Maximize — the demo
 * page, `/about/demo`, where the demo is alone — and Reset demo.
 *
 * The homepage's URL never names the demo: where the visitor is inside the
 * framed demo is kept in memory, and the demo page is the address of a place
 * in it. Coming back from the demo page (Restore, Esc, Back) shows the frame
 * grown, at the place the visitor was, scrolled to.
 */
export function LiveDemoSection(): ReactNode {
  const { entered, gateEntries } = useDemoState();
  const { consumeReturn } = useDemoActions();
  const [columnRef, column] = useElementSize<HTMLDivElement>();
  // A static render has no window; its frame is never grown (no click runs),
  // and only the grown frame reads the window's size.
  const viewport = useViewportSize(NO_WINDOW);
  const [figure, setFigure] = useState<HTMLElement | null>(null);

  // Only the visitor's own click moves the page: the grown frame's top comes
  // to the window's (its scroll margin: the gap). A tab that joined opens
  // where its page starts.
  const seenEntries = useRef(gateEntries);
  useEffect(() => {
    if (gateEntries === seenEntries.current) return;
    seenEntries.current = gateEntries;
    track("demo_enter");
    revealElement(figure, { behavior: "smooth", block: "start" });
  }, [gateEntries, figure]);
  // Back from the demo page: the frame, at once (the morph is the motion).
  useLayoutEffect(() => {
    if (figure !== null && consumeReturn())
      revealElement(figure, { behavior: "instant", block: "start" });
  }, [figure, consumeReturn]);

  const frameStyle = frameSize(column.width, viewport, entered);
  return (
    <WebsiteBand section="screenshot" divider rhythm="section">
      <div ref={columnRef}>
        <figure ref={setFigure} className="website-demo">
          <DemoTarget
            kind="framed"
            className={cn(
              "website-demo-frame",
              frameStyle !== null && "is-sized",
            )}
            style={frameStyle ?? undefined}
          />
          <figcaption
            className="website-demo-foot"
            style={
              frameStyle !== null
                ? {
                    marginLeft: frameStyle.marginLeft,
                    marginRight: frameStyle.marginLeft,
                  }
                : undefined
            }
          >
            <Text as="p" variant="label" tone="muted">
              {CAPTION}
            </Text>
            {/* The running demo's controls land here (empty until it runs). */}
            <DemoControls className="website-demo-controls" />
          </figcaption>
        </figure>
      </div>
    </WebsiteBand>
  );
}

/**
 * The frame's size: in the reading measure (`column` wide, at the frame's
 * aspect), or grown — nearly the window's width, and its height below the
 * page's floating header, centred on the measure. `null` before the measure is known: the stylesheet's aspect ratio
 * holds it meanwhile.
 */
function frameSize(
  column: number,
  viewport: ViewportSize,
  grown: boolean,
): (CSSProperties & { marginLeft: number }) | null {
  if (column === 0) return null;
  if (!grown) return { width: column, height: column / ASPECT, marginLeft: 0 };
  const width = Math.min(viewport.width - 2 * GROWN_GAP, GROWN_MAX_WIDTH);
  // What the window leaves below the page's floating header (its height, as
  // the pane publishes it), the gaps and the caption row — at most the
  // frame's own proportion. A length CSS resolves, so the growth still
  // animates between two lengths.
  const room = viewport.height - 2 * GROWN_GAP - FOOT_ROOM;
  const height = `min(calc(${room}px - var(--pane-header-height, 0px)), ${width * 0.7}px)`;
  return { width, height, marginLeft: (column - width) / 2 };
}
