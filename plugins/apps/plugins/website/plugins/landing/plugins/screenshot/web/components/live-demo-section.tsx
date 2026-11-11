import {
  useCallback,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  useViewportSize,
  type ViewportSize,
} from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { useClaimTabTitle } from "@plugins/apps-core/plugins/tabs/web";
import { SurfaceOverlay } from "@plugins/primitives/plugins/overlay/plugins/surface-overlay/web";
import {
  DemoScope,
  type DemoEntry,
} from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import {
  DEMO_FRAME_ATTR,
  DemoBootScreen,
  MaximizedChrome,
  morphDemoFrame,
  ResetDemoButton,
} from "@plugins/apps/plugins/demo/plugins/chrome/web";
import { workspaceDemo } from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
import { useDemoPlace } from "../internal/demo-place";
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
 * The homepage's live demo, where the desktop picture was: equin itself — its
 * real server code in a worker, on the workspace demo's data
 * (`<DemoScope>` around `<AppEmbed>`), opening on its home app. Nothing
 * downloads until the visitor clicks Enter equin (`DemoScope`'s gate, shown
 * on every visit; a browser that already holds the demo's data starts it
 * behind the gate, so entering is instant).
 *
 * Entering grows the frame in place, for good: out of the reading measure,
 * nearly as wide and tall as the window, the page below moving down and
 * scrolling to it. The frame is one element from the gate to the running demo
 * (the scope lives inside it), so its growth is never cut by the demo
 * arriving. Once it runs, the row under it offers Maximize (the demo grows
 * over the tab's surface, above the site — `morphDemoFrame`; Restore at its
 * top edge, or Esc when nothing inside wants it — `MaximizedChrome`) and
 * Reset demo, drawn from inside the scope, into the row, through a portal.
 *
 * Where the visitor is inside the demo, and whether it is maximized, is the
 * homepage's URL (`useDemoPlace`), so a reload comes back there: a URL that
 * names the demo opens it with no gate (`DemoScope`'s `resume`), its frame
 * grown — or maximized — showing only its loading until it runs. The plain
 * page names nothing and stays so: the demo writes no place it opened at by
 * itself (`AppEmbed` reports none), and shows the gate even while the
 * visitor is in the demo in another tab — the URL alone decides; a tab
 * opened from inside the demo carries its place, so it resumes.
 *
 * Nothing moves the page but the visitor: only Enter at the gate scrolls to
 * the grown frame — a resumed demo is grown from the start, and the embed
 * never scrolls the page around it. While the demo runs, the browser tab is
 * titled by the app inside it (the embed's title, claimed for this tab).
 */
export function LiveDemoSection(): ReactNode {
  const place = useDemoPlace();
  const { maximized, setMaximized } = place;
  // The URL names the demo (a reload, a shared link): the visitor is in it.
  const [resume] = useState(place.location !== undefined || maximized);
  // Entered: the frame grows, and stays grown.
  const [grown, setGrown] = useState(resume);
  const claimTitle = useClaimTabTitle();
  const [columnRef, column] = useElementSize<HTMLDivElement>();
  // A static render has no window; its frame is never grown (no click runs),
  // and only the grown frame reads the window's size.
  const viewport = useViewportSize(NO_WINDOW);
  const [figure, setFigure] = useState<HTMLElement | null>(null);
  const [controls, setControls] = useState<HTMLElement | null>(null);

  // The visitor came in (the gate's Enter; a join, were the URL silent).
  const grow = (how: DemoEntry) => {
    setGrown(true);
    // Only the visitor's own click moves the page: the grown frame's top
    // comes to the window's (its scroll margin: the gap). A tab that joined
    // opens where its page starts.
    if (how === "gate")
      revealElement(figure, { behavior: "smooth", block: "start" });
  };
  const frameStyle = frameSize(column.width, viewport, grown);
  const restore = useCallback(
    () => morphDemoFrame(() => setMaximized(false)),
    [setMaximized],
  );
  const embed = (
    <AppEmbed
      url={place.location}
      onLocationChange={place.move}
      browserTabUrl={place.maximizedUrl}
      fills={maximized ? "viewport" : undefined}
      onTitleChange={claimTitle}
    />
  );
  // The demo's box (what a Maximize grows): the frame, or maximized the
  // overlay — one of the two at a time.
  const frameMark = { [DEMO_FRAME_ATTR]: "" };

  return (
    <WebsiteBand section="screenshot" divider rhythm="section">
      <div ref={columnRef}>
        <figure ref={setFigure} className="website-demo">
          <div
            {...(maximized ? {} : frameMark)}
            className={cn(
              "website-demo-frame",
              frameStyle !== null && "is-sized",
            )}
            style={frameStyle ?? undefined}
          >
            <DemoScope
              scenario={workspaceDemo}
              onEnter={grow}
              resume={resume}
              // Until the demo runs: its boot screen where the demo will
              // show — in the frame, or maximized over the tab's surface.
              boot={(state) =>
                maximized ? (
                  <SurfaceOverlay
                    {...frameMark}
                    className="bg-background"
                    data-website-demo-maximized=""
                  >
                    <DemoBootScreen state={state} />
                  </SurfaceOverlay>
                ) : (
                  <DemoBootScreen state={state} />
                )
              }
            >
              {/* Maximized, the demo leaves the frame for the tab's whole
                  surface (above the site's sticky header); moving between
                  the two remounts the embed, which reopens where the visitor
                  was. */}
              {maximized ? (
                <SurfaceOverlay
                  {...frameMark}
                  className="bg-background"
                  data-website-demo-maximized=""
                >
                  {embed}
                  <MaximizedChrome onRestore={restore} />
                </SurfaceOverlay>
              ) : (
                embed
              )}
              {controls !== null &&
                createPortal(
                  <Inline gap="sm">
                    <Button
                      variant="outline"
                      onClick={() => morphDemoFrame(() => setMaximized(true))}
                    >
                      <Icon icon={symbol("fullscreen")} />
                      Maximize
                    </Button>
                    <ResetDemoButton onReset={place.restart} />
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
