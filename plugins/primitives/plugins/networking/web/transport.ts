import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import {
  SharedWebSocket,
  type SharedWebSocketOptions,
} from "./shared-websocket";

/**
 * The part of a socket a transport client relies on — what `SharedWebSocket`
 * offers, minus its introspection-only internals. A transport that is not the
 * real origin (an in-browser backend) implements exactly this.
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
 * and its asset URLs. The page's own server is `originTransport`; a
 * `<TransportProvider>` points a subtree somewhere else (an in-browser demo
 * backend), and every client that resolves its transport through
 * `useTransport()` — live-state's `NotificationsProvider`, the endpoints hooks —
 * follows it.
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
  /** The `src` an element should load for the server asset at `path`. */
  assetUrl(path: string): string;
}

/** The page's own server: same-origin sockets, the global `fetch`, plain asset paths. */
export const originTransport: Transport = {
  socketUrl: (path) => path,
  openSocket: (url, options) => new SharedWebSocket(url, undefined, options),
  fetch: (input, init) => fetch(input, init),
  assetUrl: (path) => path,
};

const TransportContext = createContext<Transport>(originTransport);

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

/** The transport of the enclosing subtree — `originTransport` outside any provider. */
export function useTransport(): Transport {
  return useContext(TransportContext);
}
