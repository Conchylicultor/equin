import {
  SharedWebSocket,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import { nativeFetch } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";
import {
  contentUrl,
  GATEWAY_PORT,
  namespaceFromHost,
} from "@plugins/infra/plugins/namespace/core";
import type { ContentServing } from "@plugins/primitives/plugins/networking/web";

/**
 * The page's content host: `<item>.content.localhost:<port>/<ns>/…` for the
 * namespace this page is served from — or `null` on a host that is no
 * namespace (a deployed site), where no content host answers.
 */
function pageContentServing(): ContentServing | null {
  if (typeof location === "undefined") return null;
  const ns = namespaceFromHost(location.host);
  if (ns === null) return null;
  const port = location.port === "" ? GATEWAY_PORT : Number(location.port);
  return {
    kind: "content-host",
    url: (item, path) => contentUrl(item, ns, path, port),
  };
}

/**
 * The page's own server: same-origin sockets (one `SharedWebSocket` per URL),
 * the native `fetch` (past the page request guard — the one raw `fetch` the
 * page's own traffic goes through), assets loaded by their own path, content
 * documents on the content host, the computer behind it, and its
 * telemetry reported (to itself). Mounted once at the app root; anything else reaching
 * for it bypasses the subtree's transport, so its importers are sanctioned one
 * by one (`networking/no-page-transport`).
 */
export const pageTransport: Transport = {
  socketUrl: (path) => path,
  openSocket: (url, options) => new SharedWebSocket(url, undefined, options),
  fetch: (input, init) => nativeFetch(input, init),
  servesUrls: true,
  content: pageContentServing(),
  machine: true,
  telemetry: true,
};
