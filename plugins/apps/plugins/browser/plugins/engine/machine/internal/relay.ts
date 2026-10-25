import type { ServerWebSocket } from "bun";
import type {
  WsData,
  WsHandler,
} from "@plugins/framework/plugins/server-core/core";
import { ENGINE_WS_PATH, type HostEvent } from "../../core";
import { engineSocketPath, ensureHost } from "./host-client";

/**
 * The backend's relay for one viewed tab: the browser's socket (through the
 * gateway) ⇄ one socket to the engine host over its Unix socket. Messages pass
 * through untouched — text stays text, a binary JPEG frame stays binary — so
 * the wire (`core/protocol.ts`) is spoken end to end and the relay knows none
 * of it but the `error` event it sends when there is no host to reach.
 *
 * Frames are latest-wins on this hop too: while the browser's socket is
 * backpressured, the newest frame is held (older ones dropped) and sent on
 * drain — the host acks a frame once it reached THIS socket, so its own
 * backpressure check never sees the browser's.
 */

/** Past this many bytes queued to the browser, a frame is held rather than queued. */
const MAX_BUFFERED = 512 * 1024;

type Client = ServerWebSocket<WsData>;

interface Relay {
  host: WebSocket | null;
  /** Client messages sent before the host socket opened, in order. */
  pending: (string | Uint8Array<ArrayBuffer>)[];
  /** The newest frame held back while the client is backpressured. */
  heldFrame: Uint8Array | null;
  closed: boolean;
}

const relays = new WeakMap<Client, Relay>();

function sendEvent(ws: Client, event: HostEvent): void {
  ws.send(JSON.stringify(event));
}

/** A close code the browser side may receive (1005/1006 are never sent). */
function forwardableCode(code: number): number {
  return code === 1005 || code === 1006 || code === 1015 ? 1011 : code;
}

function connect(ws: Client, relay: Relay): void {
  const host = new WebSocket(
    `ws+unix://${engineSocketPath()}:${ENGINE_WS_PATH}`,
  );
  host.binaryType = "arraybuffer";
  relay.host = host;
  host.onopen = () => {
    for (const msg of relay.pending) host.send(msg);
    relay.pending = [];
  };
  host.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
    if (relay.closed) return;
    if (typeof e.data === "string") {
      ws.send(e.data);
      return;
    }
    const frame = new Uint8Array(e.data);
    if (ws.getBufferedAmount() > MAX_BUFFERED) {
      relay.heldFrame = frame;
      return;
    }
    ws.send(frame);
  };
  host.onclose = (e) => {
    relay.host = null;
    if (relay.closed) return;
    relay.closed = true;
    ws.close(forwardableCode(e.code), e.reason);
  };
  host.onerror = () => {
    // Followed by `close`; say why on the client's socket first.
    if (relay.closed) return;
    sendEvent(ws, {
      t: "error",
      message: "The browser engine's socket failed.",
    });
  };
}

export const engineRelay: WsHandler = {
  open(ws) {
    const relay: Relay = {
      host: null,
      pending: [],
      heldFrame: null,
      closed: false,
    };
    relays.set(ws, relay);
    ensureHost()
      .then(() => {
        if (!relay.closed) connect(ws, relay);
      })
      .catch((err: unknown) => {
        if (relay.closed) return;
        console.error("[browser-engine] no host to relay to:", err);
        sendEvent(ws, {
          t: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        relay.closed = true;
        // 1013 "try again later": the client's reconnect backoff retries.
        ws.close(1013, "browser engine unavailable");
      });
  },
  message(ws, raw) {
    const relay = relays.get(ws);
    if (!relay || relay.closed) return;
    const msg = typeof raw === "string" ? raw : new Uint8Array(raw);
    const host = relay.host;
    if (host && host.readyState === WebSocket.OPEN) host.send(msg);
    else relay.pending.push(msg);
  },
  close(ws) {
    const relay = relays.get(ws);
    if (!relay) return;
    relays.delete(ws);
    relay.closed = true;
    relay.host?.close(1000, "client left");
  },
  drain(ws) {
    const relay = relays.get(ws);
    if (!relay?.heldFrame) return;
    const frame = relay.heldFrame;
    relay.heldFrame = null;
    ws.send(frame);
  },
};
