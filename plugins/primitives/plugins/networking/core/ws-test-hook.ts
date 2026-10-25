// The e2e test hook into the shared socket. The real WebSocket lives in a
// SharedWorker, which Playwright can neither observe (`page.on("websocket")`)
// nor route (`routeWebSocket`), so an e2e script reaches it through the tab
// instead: it installs a hook object on the page global below BEFORE the app
// boots (an init script), and every `SharedWebSocket` built in that page
// reports to it and registers its controls on it. Without the global — every
// real session — nothing reads or writes it.
//
// The e2e half is `@plugins/primitives/plugins/networking/e2e` (`tapSharedSocket`).

/** The page global a test hook is installed under. */
export const WS_TEST_HOOK_GLOBAL = "__equinWsTestHook";

/** What the shared socket did, as this tab saw it. `url` is the socket's URL as constructed (`/ws/notifications`). */
export type WsTestEvent =
  /** A status from the worker; `conn` names the server connection while open. */
  | {
      url: string;
      kind: "status";
      status: "connecting" | "open" | "reconnecting" | "closed";
      conn: string | null;
    }
  /** A server frame delivered to this tab. */
  | { url: string; kind: "rx"; data: string }
  /** A frame this tab sent toward the server. */
  | { url: string; kind: "tx"; data: string };

/** Faults a test can inject into one URL's shared socket (in its worker, so for every tab). */
export interface WsTestControls {
  /** Close the current server connection, as a network drop would (the server sees a real close). */
  drop(): void;
  /** Park every NEW connection attempt until `release()`. */
  hold(): void;
  release(): void;
}

/** The object a test installs on `WS_TEST_HOOK_GLOBAL`. */
export interface WsTestHook {
  /** Socket URLs whose worker must hold connections from the start — a socket that never connects. */
  holdFromStart: readonly string[];
  onEvent(event: WsTestEvent): void;
  /** Filled in by each `SharedWebSocket` as it is built, keyed by its URL. */
  controls: Record<string, WsTestControls>;
}

/** The installed hook, if a test installed one; `undefined` in every real session. */
export function wsTestHook(): WsTestHook | undefined {
  return (globalThis as { [WS_TEST_HOOK_GLOBAL]?: WsTestHook })[
    WS_TEST_HOOK_GLOBAL
  ];
}
