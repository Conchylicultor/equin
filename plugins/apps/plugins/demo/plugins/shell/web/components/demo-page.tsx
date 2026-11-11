import { useCallback, type ReactNode } from "react";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import {
  AppEmbed,
  useEmbedPlace,
} from "@plugins/apps-core/plugins/app-embed/web";
import {
  DEMO_FRAME_ATTR,
  MaximizedChrome,
  morphDemoFrame,
  ResetDemoButton,
} from "@plugins/apps/plugins/demo/plugins/chrome/web";
import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { DemoBootScreen } from "@plugins/apps/plugins/demo/plugins/chrome/web";
import { demoApp, demoRoute, demoScenario } from "../../core";

const CAPTION = "equin itself, running in this page on made-up data.";

/** `/demo`: the demo, framed or maximized. See {@link DemoPage}. */
export const demoPane = Pane.define({
  title: "Demo",
  route: demoRoute,
  app: demoApp,
  appIndex: true,
  component: DemoPage,
});

/**
 * The demo: equin rendered in-process (`AppEmbed`) against the demo's browser
 * server (`DemoScope` — the workspace scenario's host: real server code in a
 * worker, on the demo's data kept in this browser) — in a fixed frame under
 * the caption bar,
 * or, maximized, as the whole page, as if it were the app itself. It starts
 * on its composition's home app (the app gallery).
 *
 * Where the visitor is inside, and whether it is maximized, is the page's URL
 * (`/demo/at/agents/c/x;full=1`) — kept by the embed itself, with its history
 * rule (framed: a move rewrites the entry; maximized: each move is the app's
 * own entry) and its new browser tabs (this page there, maximized, on the
 * same data). This page only draws the frame around it.
 *
 * Maximize and Restore (its button, the strip at the top edge, Esc) run as a
 * view transition: the demo's box grows to the whole page and shrinks back
 * (`morphDemoFrame`); each is a pushed entry, so Back from maximized returns
 * to the frame. Maximized, a notice says Esc restores; Esc goes to the demo
 * first, and restores only when nothing inside wants it (`MaximizedChrome`).
 *
 * The scope lives in this pane, the app's landing pane: it never remounts (a
 * move inside rewrites only its URL), so the host never restarts. Until the
 * demo runs, its boot screen is drawn where the demo will be — framed, or,
 * the URL maximized (a reload, a new tab from inside), as the whole page.
 *
 * Framed, the caption is the page's own top bar: it is the surface's top-right
 * corner, so it reserves the global floating action bar's room and anchors it
 * (the embed is a floating-bar boundary). Maximized, the embed is that
 * corner itself, so its headers make room for the bar as the app's own do.
 * Switching between the two restyles the same tree — the embed stays mounted.
 */
function DemoPage(): ReactNode {
  const { maximized, setMaximized, reset } = useEmbedPlace();
  const setFull = useCallback(
    (on: boolean) => morphDemoFrame(() => setMaximized(on)),
    [setMaximized],
  );
  const restore = useCallback(() => setFull(false), [setFull]);
  return (
    <DemoScope
      scenario={demoScenario}
      boot={(state) => (
        <DemoFrame full={maximized}>
          <DemoBootScreen state={state} />
        </DemoFrame>
      )}
    >
      <DemoFrame
        full={maximized}
        controls={
          <>
            <Button variant="outline" onClick={() => setFull(true)}>
              <Icon icon={symbol("fullscreen")} />
              Maximize
            </Button>
            <ResetDemoButton onReset={reset} />
          </>
        }
      >
        {/* The embed is all this page shows: its shortcuts answer at once. */}
        <AppEmbed fills={maximized ? "viewport" : "page"} />
        {maximized && <MaximizedChrome onRestore={restore} />}
      </DemoFrame>
    </DemoScope>
  );
}

/**
 * The demo's page: the caption bar (the caption, then `controls`) over the
 * demo framed below it — or, `full`, the demo as the whole page (`children`
 * fill the frame either way; an overlay of the full page rides along). Also
 * what the demo's boot screen is drawn in (`DemoLayout`), so the caption bar
 * stays while the demo starts.
 */
export function DemoFrame({
  full,
  controls,
  children,
}: {
  full: boolean;
  controls?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <Stack gap="none" className="relative h-full bg-background">
      {!full && (
        <Bar>
          <Text as="p" variant="label" tone="muted">
            {CAPTION}
          </Text>
          <Inline gap="sm">{controls}</Inline>
        </Bar>
      )}
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- the demo's frame region: fills the space under the caption bar, padded when framed
        className={cn("flex min-h-0 flex-1 flex-col", !full && "p-lg")}
      >
        <div
          {...{ [DEMO_FRAME_ATTR]: "" }}
          // eslint-disable-next-line layout/no-adhoc-layout -- the demo's frame: the embedded app fills it
          className={cn(
            "relative min-h-0 flex-1",
            !full && "overflow-hidden rounded-lg border",
          )}
        >
          {children}
        </div>
      </div>
    </Stack>
  );
}
