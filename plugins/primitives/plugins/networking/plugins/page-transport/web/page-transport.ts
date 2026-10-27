import {
  SharedWebSocket,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import { nativeFetch } from "@plugins/primitives/plugins/networking/plugins/request-guard/web";

/**
 * The page's own server: same-origin sockets (one `SharedWebSocket` per URL),
 * the native `fetch` (past the page request guard — the one raw `fetch` the
 * page's own traffic goes through), assets loaded by their own path, the computer behind it, and its
 * telemetry reported (to itself). Mounted once at the app root; anything else reaching
 * for it bypasses the subtree's transport, so its importers are sanctioned one
 * by one (`networking/no-page-transport`).
 */
export const pageTransport: Transport = {
  socketUrl: (path) => path,
  openSocket: (url, options) => new SharedWebSocket(url, undefined, options),
  fetch: (input, init) => nativeFetch(input, init),
  servesUrls: true,
  machine: true,
  telemetry: true,
};
