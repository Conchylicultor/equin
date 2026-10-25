import {
  ENGINE_WS_PATH,
  type ClientMessage,
} from "@plugins/apps/plugins/browser/plugins/engine/core";
import { useBrowserRemote } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { useReconnectingWebSocket } from "@plugins/primitives/plugins/networking/web";

/**
 * Delivers one closed tab's `close` to the host: a short socket that attaches
 * to the page and closes it, then drops the key from the store (which
 * unmounts this, closing the socket). Renders nothing.
 *
 * Its own socket rather than the tab's because the closed tab is usually not
 * the one streaming (and a closed active tab's socket is gone with its
 * canvas). The protocol speaks to a page only after `attach`, so this attaches
 * first — with a 1×1 viewport, the page is about to go.
 */
export function RemoteClose({ pageKey }: { pageKey: string }) {
  const { closeDelivered } = useBrowserRemote();
  useReconnectingWebSocket({
    path: ENGINE_WS_PATH,
    onOpen(socket) {
      const attach: ClientMessage = {
        t: "attach",
        key: pageKey,
        url: "about:blank",
        viewport: { width: 1, height: 1, dpr: 1 },
      };
      const close: ClientMessage = { t: "close" };
      socket.send(JSON.stringify(attach));
      socket.send(JSON.stringify(close));
      closeDelivered(pageKey);
    },
  });
  return null;
}
