import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { SurfaceOverlay } from "@plugins/primitives/plugins/overlay/plugins/surface-overlay/web";
import {
  DemoScope,
  type DemoBoot,
} from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import {
  DemoBootScreen,
  ResetDemoButton,
  RestoreStrip,
} from "@plugins/apps/plugins/demo/plugins/chrome/web";
import { workspaceDemo } from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
import "./live-demo-section.css";

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
 * The homepage's live demo, where the desktop picture was: equin itself — its
 * real server code in a worker, on the workspace demo's data
 * (`<DemoScope>` around `<AppEmbed>`), opening on its home app. Nothing
 * downloads until the visitor clicks Enter equin (`DemoScope`'s gate; a
 * browser that already holds the demo's data starts it at once).
 *
 * Entering grows the frame in place: out of the reading measure, nearly as
 * wide and tall as the window, the page below moving down and scrolling to
 * it. The frame is one element from the gate to the running demo (the scope
 * lives inside it), so its growth is never cut by the demo arriving. Once it
 * runs, the row under it offers Maximize (the demo fills the tab's surface,
 * above the site; Restore at its top edge), Collapse / Expand, and Reset
 * demo — drawn from inside the scope, into the row, through a portal.
 */
export function LiveDemoSection(): ReactNode {
  const [grown, setGrown] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // Where the visitor is inside the demo (the embed's app-rooted URL);
  // `undefined` until it moves: the demo's home app.
  const [location, setLocation] = useState<string | undefined>(undefined);
  const [columnRef, column] = useElementSize<HTMLDivElement>();
  const viewport = useViewportSize();
  const [figure, setFigure] = useState<HTMLElement | null>(null);
  const [controls, setControls] = useState<HTMLElement | null>(null);

  const grow = () => {
    setGrown(true);
    // The grown frame's top comes to the window's (its scroll margin: the gap).
    revealElement(figure, { behavior: "smooth", block: "start" });
  };
  const frameStyle = frameSize(column.width, viewport, grown);
  const embed = <AppEmbed url={location} onLocationChange={setLocation} />;

  return (
    <WebsiteBand section="screenshot" divider rhythm="section">
      <div ref={columnRef}>
        <figure ref={setFigure} className="website-demo">
          <div
            className={cn(
              "website-demo-frame",
              frameStyle !== null && "is-sized",
            )}
            style={frameStyle ?? undefined}
          >
            <DemoScope
              scenario={workspaceDemo}
              boot={(state) => (
                <DemoBootScreen state={enterGrows(state, grow)} />
              )}
            >
              {/* Maximized, the demo leaves the frame for the tab's whole
                  surface (above the site's sticky header); moving between
                  the two remounts the embed, which reopens where the visitor
                  was. */}
              {maximized ? (
                <SurfaceOverlay
                  className="bg-background"
                  data-website-demo-maximized=""
                >
                  {embed}
                  <RestoreStrip onRestore={() => setMaximized(false)} />
                </SurfaceOverlay>
              ) : (
                embed
              )}
              {controls !== null &&
                createPortal(
                  <Inline gap="sm">
                    <Button
                      variant="outline"
                      onClick={() => setMaximized(true)}
                    >
                      <Icon icon={symbol("fullscreen")} />
                      Maximize
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => (grown ? setGrown(false) : grow())}
                    >
                      {grown ? "Collapse" : "Expand"}
                    </Button>
                    <ResetDemoButton />
                  </Inline>,
                  controls,
                )}
            </DemoScope>
          </div>
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
            <span ref={setControls} className="website-demo-controls" />
          </figcaption>
        </figure>
      </div>
    </WebsiteBand>
  );
}

/** The gate's Enter also grows the frame: the demo arrives large. */
function enterGrows(state: DemoBoot, grow: () => void): DemoBoot {
  if (state.kind !== "gate") return state;
  return {
    kind: "gate",
    enter: () => {
      grow();
      state.enter();
    },
  };
}

interface ViewportSize {
  width: number;
  height: number;
}

/** The window's size, kept current by its resize events. */
function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const changed = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", changed);
    return () => window.removeEventListener("resize", changed);
  }, []);
  return size;
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
