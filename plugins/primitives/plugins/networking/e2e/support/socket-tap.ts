import type { Page } from "playwright";
import {
  WS_TEST_HOOK_GLOBAL,
  type WsTestControls,
  type WsTestEvent,
  type WsTestHook,
} from "../../core";

/** The binding the page's hook reports through. */
const EMIT_BINDING = "__equinWsTestEmit";

export interface SocketTapOptions {
  /** Socket URLs (`/ws/notifications`) whose worker must never connect — a page with no live socket. */
  holdFromStart?: readonly string[];
}

/** One server frame delivered to the page. */
export interface TappedFrame {
  /** The socket's URL as the app built it (`/ws/notifications`). */
  url: string;
  /** The server connection it arrived on (null only if none was reported yet). */
  conn: string | null;
  /** The raw frame text — every live-state frame is one JSON object. */
  data: string;
}

/**
 * What one page saw of its shared sockets, plus the faults it can inject.
 * Replaces `page.on("websocket")` / `routeWebSocket`, which cannot reach a
 * socket living in a SharedWorker.
 */
export interface SocketTap {
  /** Every raw event, in order, for every socket of the page. */
  readonly events: readonly WsTestEvent[];
  /** Call `listener` for every server frame the page receives from now on. */
  onFrame(listener: (frame: TappedFrame) => void): void;
  /** Frames the page sent on `url`, parsed. */
  sent(url: string): Record<string, unknown>[];
  /** The distinct server connections the page was bound to on `url`, in order. */
  connections(url: string): string[];
  /** The last status the page saw on `url` (null before any). */
  status(url: string): string | null;
  /**
   * Fault injection on `url`'s worker — so for every page of the browser
   * context. `drop` loses the current connection as a network drop would (the
   * server sees a close; the reconnect path runs); `hold` parks every new
   * connection attempt until `release`.
   */
  drop(url: string): Promise<void>;
  hold(url: string): Promise<void>;
  release(url: string): Promise<void>;
}

/**
 * Tap a page's shared sockets. Call BEFORE the page's first navigation: the
 * hook must be on the page before the app builds its sockets.
 */
export async function tapSharedSocket(
  page: Page,
  opts: SocketTapOptions = {},
): Promise<SocketTap> {
  const events: WsTestEvent[] = [];
  const listeners: Array<(frame: TappedFrame) => void> = [];
  const conn = new Map<string, string | null>();
  await page.exposeFunction(EMIT_BINDING, (event: WsTestEvent) => {
    events.push(event);
    if (event.kind === "status") conn.set(event.url, event.conn);
    if (event.kind !== "rx") return;
    const frame = {
      url: event.url,
      conn: conn.get(event.url) ?? null,
      data: event.data,
    };
    for (const fn of listeners) fn(frame);
  });
  await page.addInitScript(
    ({ global, binding, holdFromStart }) => {
      const emit = (window as unknown as Record<string, (e: unknown) => void>)[
        binding
      ]!;
      const hook: WsTestHook = {
        holdFromStart,
        controls: {},
        onEvent: (event) => emit(event),
      };
      Object.assign(window, { [global]: hook });
    },
    {
      global: WS_TEST_HOOK_GLOBAL,
      binding: EMIT_BINDING,
      holdFromStart: [...(opts.holdFromStart ?? [])],
    },
  );

  const control =
    (fault: keyof WsTestControls) =>
    async (url: string): Promise<void> => {
      await page.evaluate(
        ({ global, url, fault }) => {
          const hook = (window as unknown as Record<string, WsTestHook>)[
            global
          ];
          const controls = hook?.controls[url];
          if (!controls) {
            throw new Error(
              `tapSharedSocket: no shared socket for ${url} has been built in this page`,
            );
          }
          controls[fault]();
        },
        { global: WS_TEST_HOOK_GLOBAL, url, fault },
      );
    };

  return {
    events,
    onFrame: (listener) => {
      listeners.push(listener);
    },
    sent: (url) =>
      events.flatMap((e) =>
        e.url === url && e.kind === "tx"
          ? [JSON.parse(e.data) as Record<string, unknown>]
          : [],
      ),
    connections: (url) => {
      const seen: string[] = [];
      for (const e of events) {
        if (e.url === url && e.kind === "status" && e.conn !== null) {
          if (seen.at(-1) !== e.conn) seen.push(e.conn);
        }
      }
      return seen;
    },
    status: (url) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        if (e.url === url && e.kind === "status") return e.status;
      }
      return null;
    },
    drop: control("drop"),
    hold: control("hold"),
    release: control("release"),
  };
}
