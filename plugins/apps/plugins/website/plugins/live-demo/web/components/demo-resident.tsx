import { useCallback, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  AppEmbed,
  type EmbedPlaceBinding,
} from "@plugins/apps-core/plugins/app-embed/web";
import {
  useClaimTabTitle,
  useNavigate,
} from "@plugins/apps-core/plugins/tabs/web";
import { withActiveRoutePrefix } from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import {
  DemoBootScreen,
  BackToSitePill,
  morphDemoFrame,
  ResetDemoButton,
} from "@plugins/apps/plugins/website/plugins/landing/plugins/screenshot/plugins/chrome/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { workspaceDemo } from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";
import {
  DemoStoreProvider,
  useDemoActions,
  useDemoState,
  type DemoTargetEntry,
} from "../internal/demo-store";
import { landingUrl } from "../internal/demo-url";
import { demoPagePath } from "../../core";

/**
 * The live demo's resident, wrapping the site's pages (`Website.Resident`):
 * the demo's state for the visit (its store's scope, around the pages and the
 * server alike) and the server itself, beside the pages.
 */
export function DemoResident({ children }: { children: ReactNode }): ReactNode {
  return (
    <DemoStoreProvider>
      {children}
      <DemoServer />
    </DemoStoreProvider>
  );
}

/**
 * The live demo's server, for the whole visit: mounted by the site's surface
 * (`Website.Resident`), so moving between the homepage's frame and the demo
 * page never ends it. Nothing mounts until a page first asks for the demo
 * (a `DemoTarget`) — another site page starts no worker — and from then on
 * one `<DemoScope>` stays (`resume` while the demo page shows, whose URL
 * says the visitor is in; the homepage frame shows the gate on every load). Its boot screen and the running demo
 * are drawn into whichever box the current page claimed, through a portal;
 * on a page without one, nothing is drawn and the server keeps running.
 */
function DemoServer(): ReactNode {
  const { started, target } = useDemoState();
  const demo = useDemoActions();
  const navigate = useNavigate();
  const maximize = useCallback(() => {
    track("demo_maximize");
    demo.maximizing();
    morphDemoFrame(() => navigate(demoPagePath(demo.peek().place)));
  }, [demo, navigate]);
  const restore = useCallback(
    () => morphDemoFrame(() => navigate(landingUrl())),
    [navigate],
  );
  if (!started) return null;
  return (
    <DemoScope
      scenario={workspaceDemo}
      onEnter={demo.entered}
      // The demo page's URL names a place in the demo: the visitor is in,
      // whichever page mounted the scope first. The homepage's URL names no
      // place: its frame shows the gate on every load, even while the
      // visitor is in the demo in another tab — the gate is only a doorway
      // (Enter connects to the same shared host, already started behind it
      // when this browser holds the data), so a reload starts from it.
      resume={target?.kind === "page"}
      boot={(state) =>
        target === null
          ? null
          : createPortal(
              <DemoBootScreen state={state} />,
              target.element,
              target.kind,
            )
      }
    >
      {target !== null && (
        <ResidentDemo
          target={target}
          onMaximize={maximize}
          onRestore={restore}
        />
      )}
    </DemoScope>
  );
}

/** The running demo, in the current page's box, and the frame's controls. */
function ResidentDemo({
  target,
  onMaximize,
  onRestore,
}: {
  target: DemoTargetEntry;
  onMaximize: () => void;
  onRestore: () => void;
}): ReactNode {
  const { place, controls, viaMaximize } = useDemoState();
  const { setPlace } = useDemoActions();
  const claimTitle = useClaimTabTitle();
  // The framed demo's place: memory, never the homepage's URL.
  const framed = useMemo<EmbedPlaceBinding>(
    () => ({
      location: place,
      onLocationChange: (url) => setPlace(url),
      browserTabUrl: (at) => withActiveRoutePrefix(demoPagePath(at)),
    }),
    [place, setPlace],
  );
  const page = target.kind === "page";
  return (
    <>
      {createPortal(
        <>
          {/* Moving between the frame and the page remounts the embed (a
              new box), which reopens at its binding's place. */}
          <AppEmbed
            place={target.place ?? framed}
            fills={page ? "viewport" : undefined}
            onTitleChange={claimTitle}
          />
          {/* The way back, only for a visitor who maximized the homepage's
              frame — a link or the apps gallery opens the demo page alone. */}
          {page && viaMaximize && (
            <BackToSitePill onBack={onRestore} bounds={target.element} />
          )}
        </>,
        target.element,
        target.kind,
      )}
      {!page &&
        controls !== null &&
        createPortal(
          <Inline gap="sm">
            <Button variant="outline" onClick={onMaximize}>
              <Icon icon={symbol("fullscreen")} />
              Maximize
            </Button>
            <ResetDemoButton
              onReset={() => {
                track("demo_reset");
                setPlace(undefined);
              }}
            />
          </Inline>,
          controls,
        )}
    </>
  );
}
