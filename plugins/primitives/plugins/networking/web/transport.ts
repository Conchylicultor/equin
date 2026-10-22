import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import type {
  SharedWebSocket,
  SharedWebSocketOptions,
} from "./shared-websocket";

/**
 * The part of a socket a transport client relies on — what `SharedWebSocket`
 * offers, minus its introspection-only internals. A transport that is not the
 * page's own server (an in-browser backend) implements exactly this.
 */
export type TransportSocket = Pick<
  SharedWebSocket,
  | "send"
  | "close"
  | "setLastWill"
  | "onopen"
  | "onmessage"
  | "attachedTabs"
  | "connection"
>;

/**
 * Where a subtree's server traffic goes: its live sockets, its HTTP requests
 * and the assets its elements load. The page's own server is `pageTransport`
 * (`networking/page-transport`, mounted at the app root); a
 * `<TransportProvider>` points a subtree somewhere else (an in-browser demo
 * backend), and every client that resolves its transport through
 * `useTransport()` — live-state's `NotificationsProvider`, the endpoints hooks —
 * follows it. There is no default: a client outside every provider throws.
 */
export interface Transport {
  /**
   * The URL a live socket for `path` (`/ws/notifications`, …) is opened at. It
   * is also the identity the ws-status bus reports that socket under, so two
   * transports must never map one path to the same URL — a client would
   * otherwise read the other transport's socket status as its own.
   */
  socketUrl(path: string): string;
  /** Opens the socket for a URL `socketUrl` returned. */
  openSocket(url: string, options?: SharedWebSocketOptions): TransportSocket;
  /** `fetch` for every relative `/api/…` request of the subtree. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /**
   * Whether an element (`<img>`, `<a href>`, `<iframe>`) can load this
   * transport's `/api/…` paths by URL itself — the page's own server, same
   * origin. `false` (an in-browser server, which no URL reaches): an asset is
   * fetched through {@link fetch} and handed to the element as a blob URL
   * (`useAssetSrc`, `infra/endpoints`). Required, so every transport states
   * it.
   */
  readonly servesUrls: boolean;
  /**
   * Whether the computer is behind this transport — the desktop app's own
   * server — so a declaration that needs it (`needsMachine`: an endpoint, a
   * live read) can be asked. `false` (an in-browser server): its clients answer
   * such a declaration `unavailable` without asking. Required, so every
   * transport states it.
   */
  readonly machine: boolean;
  /**
   * Whether the telemetry this subtree's server traffic raises is reported —
   * to the page's own server, the one telemetry receiver: an endpoint's
   * failure (`endpointErrorSink`), a live read's error and stale drops, and
   * the update / confirm latency samples. Each emission site checks the
   * transport its traffic went over, so a subtree pointed at an in-browser
   * server reports exactly when this is `true` (today: it inherits the
   * enclosing page's), and `false` — the strict setting for a sealed scope —
   * drops it at the source. A flag, never a transport: nothing reaches the
   * page's server through a subtree's context. Page-wide handlers
   * (`window.onerror`, boot, the crash beacon, the UI's own observers) belong
   * to the page and report through `pageTransport` regardless.
   */
  readonly telemetry: boolean;
}

const TransportContext = createContext<Transport | null>(null);

/** Points every transport client in `children` at `transport`. */
export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: ReactNode;
}) {
  return createElement(
    TransportContext.Provider,
    { value: transport },
    children,
  );
}

/**
 * The transport of the enclosing subtree. Throws outside every
 * `<TransportProvider>`: there is no implicit server to fall back to (the app
 * root mounts the page's; a test mounts one through `web/testing`'s
 * `renderWithTransport`).
 */
export function useTransport(): Transport {
  const transport = useContext(TransportContext);
  if (transport === null) {
    throw new Error(
      "useTransport: no <TransportProvider> above this component — the app root mounts the page's transport; a test mounts one with renderWithTransport (@plugins/primitives/plugins/networking/web/testing).",
    );
  }
  return transport;
}
