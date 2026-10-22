import { useEffect, useRef } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { publishWsStatus, type WsStatus } from "./ws-status-bus";
import { ReconnectSchedule } from "./reconnect-backoff";
import { useTransport } from "./transport";
import { wsUrl } from "./ws-url";

export interface ReconnectingWsOptions {
  /**
   * The socket's path on the subtree's server (`/ws/logs`). A per-tab socket
   * is opened at it by URL, so only a transport whose paths a URL reaches
   * (`servesUrls`: the page's own server) carries one — under any other the
   * hook throws: an in-browser server serves no such socket, and a socket
   * opened by URL there would reach the page's real server instead. A caller
   * that may render under one checks `useTransport().servesUrls` first and
   * says the feed is unavailable.
   */
  path: string;
  onOpen?: (ws: WebSocket) => void;
  onMessage?: (ev: MessageEvent) => void;
  onStatusChange?: (status: WsStatus) => void;
  enabled?: boolean;
}

export interface ReconnectingWsHandle {
  send: (data: string) => void;
  close: () => void;
}

const SEND_QUEUE_LIMIT = 1000;
const CLOSE_SENTINEL = 4000;

export function useReconnectingWebSocket(opts: ReconnectingWsOptions): {
  current: ReconnectingWsHandle | null;
} {
  const handleRef = useRef<ReconnectingWsHandle | null>(null);
  const optsRef = useLatestRef(opts);
  const { servesUrls } = useTransport();
  const url = wsUrl(opts.path);

  useEffect(() => {
    if (opts.enabled === false) return;

    let ws: WebSocket | null = null;
    const reconnect = new ReconnectSchedule();
    let disposed = false;
    const queue: string[] = [];

    const setStatus = (status: WsStatus) => {
      publishWsStatus({ url, status });
      optsRef.current.onStatusChange?.(status);
    };

    const connect = () => {
      if (disposed) return;
      setStatus(reconnect.isFirstAttempt ? "connecting" : "reconnecting");
      ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        if (disposed || !ws) return;
        reconnect.reset();
        setStatus("open");
        optsRef.current.onOpen?.(ws);
        while (queue.length > 0 && ws.readyState === WebSocket.OPEN) {
          const msg = queue.shift();
          if (msg !== undefined) ws.send(msg);
        }
      });

      ws.addEventListener("message", (ev) => {
        optsRef.current.onMessage?.(ev);
      });

      ws.addEventListener("close", (ev) => {
        if (disposed || ev.code === CLOSE_SENTINEL) {
          setStatus("closed");
          return;
        }
        setStatus("reconnecting");
        reconnect.schedule(connect);
      });

      ws.addEventListener("error", () => {
        // close handler will fire next and schedule reconnect
      });
    };

    handleRef.current = {
      send(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        } else if (queue.length < SEND_QUEUE_LIMIT) {
          queue.push(data);
        }
      },
      close() {
        disposed = true;
        reconnect.cancel();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(CLOSE_SENTINEL);
        } else if (ws) {
          ws.close();
        }
      },
    };

    connect();

    return () => {
      disposed = true;
      reconnect.cancel();
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) ws.close(CLOSE_SENTINEL);
        else ws.close();
      }
      handleRef.current = null;
    };
    // The effect intentionally re-runs only on url/enabled — every other opt is
    // read live off the stable `optsRef.current`.
  }, [url, opts.enabled]);

  // Thrown from render, so the effect above never commits under such a
  // transport.
  if (!servesUrls) {
    throw new Error(
      `useReconnectingWebSocket("${opts.path}"): this subtree's transport serves no URL (an in-browser server), so no per-tab socket reaches it — a socket opened by URL would reach the page's own server instead. Check useTransport().servesUrls before mounting a live feed.`,
    );
  }

  return handleRef;
}
