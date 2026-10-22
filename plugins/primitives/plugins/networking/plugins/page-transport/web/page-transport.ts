import {
  SharedWebSocket,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";

/**
 * The page's own server: same-origin sockets (one `SharedWebSocket` per URL),
 * the global `fetch`, assets loaded by their own path, the computer behind it, and its
 * telemetry reported (to itself). Mounted once at the app root; anything else reaching
 * for it bypasses the subtree's transport, so its importers are sanctioned one
 * by one (`networking/no-page-transport`).
 */
export const pageTransport: Transport = {
  socketUrl: (path) => path,
  openSocket: (url, options) => new SharedWebSocket(url, undefined, options),
  fetch: (input, init) => fetch(input, init),
  servesUrls: true,
  machine: true,
  telemetry: true,
};
