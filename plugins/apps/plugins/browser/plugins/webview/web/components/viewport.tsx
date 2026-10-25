import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import {
  Browser,
  useBrowserRemote,
} from "@plugins/apps/plugins/browser/plugins/shell/web";
import { LoadingBar } from "./loading-bar";
import { RemoteClose } from "./remote-close";
import { RemoteTab } from "./remote-tab";

/**
 * The webview viewport. The active tab's page streams from the engine's
 * Chromium onto a canvas ({@link RemoteTab}); inactive tabs render nothing
 * (their remote pages stay alive on the host, and stream again when
 * selected). The start page (URL `""`) renders the contributed start page.
 * Closed tabs' remote pages are closed here ({@link RemoteClose}).
 */
export function Viewport() {
  const { tabs, activeId, pendingCloses } = useBrowserRemote();
  const { servesUrls } = useTransport();
  const active = tabs.find((t) => t.id === activeId);

  return (
    <Overlay
      fill
      className="h-full w-full bg-background"
      above={active?.loading ? <LoadingBar /> : undefined}
    >
      {!active || active.url === "" ? (
        <StartPageHost />
      ) : servesUrls ? (
        <RemoteTab key={active.id} tab={active} />
      ) : (
        <Center className="h-full w-full">
          <Placeholder>
            Pages open in a real Chromium on your computer — this browser needs
            the desktop app&apos;s server, which this view does not have.
          </Placeholder>
        </Center>
      )}
      {servesUrls &&
        pendingCloses.map((key) => <RemoteClose key={key} pageKey={key} />)}
    </Overlay>
  );
}

/**
 * Renders the contributed start page, or a tiny inline hint if none is
 * registered.
 */
function StartPageHost() {
  const startPages = Browser.StartPage.useContributions();
  if (startPages.length > 0) {
    return (
      // eslint-disable-next-line layout/no-adhoc-layout -- start page scrolls within the fixed-height viewport box.
      <div className="h-full w-full overflow-auto">
        <Browser.StartPage.Render />
      </div>
    );
  }
  return (
    <Center className="h-full w-full">
      <Placeholder>Enter a URL to begin</Placeholder>
    </Center>
  );
}
