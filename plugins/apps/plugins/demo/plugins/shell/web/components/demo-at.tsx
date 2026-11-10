import { useCallback, type ReactNode } from "react";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Pane, type HistoryMode } from "@plugins/primitives/plugins/pane/web";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import {
  ResetDemoButton,
  RestoreStrip,
} from "@plugins/apps/plugins/demo/plugins/chrome/web";
import { DEMO_FULL, demoApp, demoAtRoute } from "../../core";
import {
  locationParam,
  locationUrl,
  useStartLocation,
} from "../internal/location";

const CAPTION = "equin itself, running in this page on made-up data.";

/** `/demo/at/<location>[;full=1]`: the demo at one location. See {@link DemoAt}. */
export const demoAtPane = Pane.define({
  title: "Demo",
  route: demoAtRoute,
  app: demoApp,
  component: DemoAt,
  // Every move inside the demo and the Maximize switch rewrite this one
  // instance's params in place — so the demo never remounts — each a history
  // entry or not per {@link DemoAt}'s history rule.
  useResolve: false,
});

/**
 * The demo at one location: equin rendered in-process (`AppEmbed`) against
 * the demo's browser server (the layout's `DemoScope`) — in a fixed frame
 * under the caption bar, or, maximized (`;full=1`), as the whole page, as
 * if it were the app itself.
 *
 * The page's URL is where the visitor is inside: the embed reports its
 * location and this pane writes it into its own params, so a reload reopens
 * the demo there. A new browser tab opened from inside (a ⌘-click, an Open in
 * a new tab) opens this page at that place, maximized — the same demo, on
 * the same data (every tab shares the demo's one SharedWorker).
 *
 * History follows who owns the tab. Maximized, the demo IS the tab, so its
 * moves are the page's: each is the history entry the app's own tab would
 * write (a link pushes one, a redirect rewrites it), and Back / Forward step
 * through them — the embed follows the URL there. Framed, the demo is a box
 * on a page: its moves rewrite the current entry, so Back leaves the page
 * rather than replaying clicks made inside a widget. Switching between the
 * two is the page's own navigation (a pushed entry): Back from maximized
 * returns to the frame.
 *
 * Framed, the caption is the page's own top bar: it is the surface's top-right
 * corner, so it reserves the global floating action bar's room and anchors it
 * (the embed is a floating-bar boundary). Maximized, the embed is that
 * corner itself, so its headers make room for the bar as the app's own do.
 * Switching between the two restyles the same tree — the embed stays mounted.
 */
function DemoAt(): ReactNode {
  const { url, full } = demoAtPane.useParams();
  const setParams = demoAtPane.useSetParams();
  const isFull = full === DEMO_FULL;
  const paramsRef = useLatestRef({ url, full });
  const onLocationChange = useCallback(
    (next: string, history: HistoryMode) => {
      const param = locationParam(next);
      const current = paramsRef.current;
      if (param === "" || param === current.url) return;
      setParams(
        { ...current, url: param },
        { replace: current.full !== DEMO_FULL || history === "replace" },
      );
    },
    [paramsRef, setParams],
  );
  const start = useStartLocation();
  const setFull = (on: boolean) =>
    setParams({ url: paramsRef.current.url, full: on ? DEMO_FULL : undefined });
  return (
    <DemoFrame
      full={isFull}
      controls={
        <>
          <Button variant="outline" onClick={() => setFull(true)}>
            <Icon icon={symbol("fullscreen")} />
            Maximize
          </Button>
          <ResetDemoButton
            onReset={() => {
              if (start !== undefined)
                setParams(
                  { ...paramsRef.current, url: start },
                  { replace: true },
                );
            }}
          />
        </>
      }
    >
      {/* The embed is all this page shows: its shortcuts answer at once. */}
      <AppEmbed
        url={locationUrl(url)}
        fills={isFull ? "viewport" : "page"}
        onLocationChange={onLocationChange}
        browserTabUrl={maximizedUrl}
      />
      {isFull && <RestoreStrip onRestore={() => setFull(false)} />}
    </DemoFrame>
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
          // eslint-disable-next-line layout/no-adhoc-layout -- the demo's frame: the embedded app fills it
          className={cn(
            "min-h-0 flex-1",
            !full && "overflow-hidden rounded-lg border",
          )}
        >
          {children}
        </div>
      </div>
    </Stack>
  );
}

/** This page at `location`, maximized: what a new tab from inside opens. */
function maximizedUrl(location: string): string {
  return demoAtRoute.link(demoApp, {
    url: locationParam(location),
    full: DEMO_FULL,
  });
}
