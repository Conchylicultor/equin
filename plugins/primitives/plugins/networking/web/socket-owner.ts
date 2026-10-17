import type { NetDiagEvent } from "./net-diag-bus";
import { ReconnectSchedule } from "./reconnect-backoff";
import type { SocketFault } from "./shared-ws-protocol";
import type { MakeWebSocket, WebSocketLike } from "./transport-types";
import type { WsStatus } from "./ws-status-bus";

const WS_OPEN = 1;

/**
 * How long one connection attempt may stay CONNECTING. A handshake that
 * neither opens nor closes fires no event at all, so without a deadline the
 * socket sits in "connecting" forever and every tab on it waits with it. Past
 * the deadline the attempt is abandoned and reconnected — after publishing
 * `ws-connect-stalled`, so the hang is reported, not just healed. Generous on
 * purpose: a cold backend boot behind the gateway can legitimately hold a
 * handshake for seconds; this catches the attempt that is never answered.
 */
export const CONNECT_DEADLINE_MS = 15_000;

export interface SocketOwnerEvents {
  /** Every status transition; `conn` names the server connection while "open". */
  onStatus(status: WsStatus, conn: string | null): void;
  onMessage(data: string): void;
  onError(): void;
  onDiag(event: NetDiagEvent): void;
}

/**
 * The one real WebSocket for a URL: connect, queue-until-open, reconnect with
 * backoff, and a fresh connection id per real open. Lives inside the
 * SharedWorker (`shared-ws-host.ts`), so exactly one exists per URL per worker
 * build — by construction, not by election.
 *
 * Runs in the worker bundle: imports only this plugin's own files (see
 * `reconnect-backoff.ts`).
 */
export class SocketOwner {
  status: WsStatus = "connecting";
  /** Identity of the current server connection; null while not open. */
  conn: string | null = null;

  private ws: WebSocketLike | null = null;
  private queue: string[] = [];
  private reconnect = new ReconnectSchedule();
  /** The current attempt's connect deadline; null once it opened or closed. */
  private connectDeadline: ReturnType<typeof setTimeout> | null = null;
  /** Attempts since the last open (0 = first connect), for diagnostics. */
  private attempt = 0;
  private closed = false;
  /** Test fault: new connection attempts park instead of dialing. */
  private held = false;
  /** A connection attempt parked by `held`, run on release. */
  private parked = false;

  constructor(
    private readonly url: string,
    private readonly makeWebSocket: MakeWebSocket,
    private readonly events: SocketOwnerEvents,
  ) {}

  start(): void {
    this.setStatus("connecting", null);
    this.connect();
  }

  /** Write now, or queue until the next open. */
  send(data: string): void {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WS_OPEN) this.write(this.ws, data);
    else this.queue.push(data);
  }

  /**
   * Write only if a connection is open. For frames that describe the CURRENT
   * connection's state (a departing port's will): a new connection never held
   * that state, so replaying it there would be meaningless.
   */
  sendIfOpen(data: string): void {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WS_OPEN) this.write(this.ws, data);
  }

  /**
   * Simulate a fault, for e2e tests (`core/ws-test-hook.ts`): `drop` loses the
   * current connection the way a network drop does (the server sees a close,
   * the reconnect path runs); `hold` parks every new connection attempt until
   * `release`.
   */
  fault(fault: SocketFault): void {
    if (this.closed) return;
    switch (fault) {
      case "drop": {
        const ws = this.ws;
        if (!ws) return;
        this.detach(ws);
        ws.close();
        this.lost();
        return;
      }
      case "hold":
        this.held = true;
        return;
      case "release":
        this.held = false;
        if (this.parked) {
          this.parked = false;
          this.connect();
        }
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconnect.cancel();
    this.clearConnectDeadline();
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    this.conn = null;
    if (!ws) return;
    this.detach(ws);
    ws.close();
  }

  private detach(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }

  /** The connection is gone (closed by the server, the network, or a `drop`). */
  private lost(): void {
    this.clearConnectDeadline();
    this.ws = null;
    if (this.closed) return;
    this.events.onDiag({ type: "ws-close", url: this.url });
    this.setStatus("reconnecting", null);
    this.scheduleReconnect();
  }

  private connect = (): void => {
    if (this.closed) return;
    this.reconnect.cancel();
    if (this.held) {
      this.parked = true;
      return;
    }

    let ws: WebSocketLike;
    try {
      ws = this.makeWebSocket(this.url);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const startedAt = Date.now();
    const attempt = this.attempt++;
    this.clearConnectDeadline();
    this.connectDeadline = setTimeout(() => {
      this.connectDeadline = null;
      if (this.ws !== ws || ws.readyState === WS_OPEN) return;
      this.events.onDiag({
        type: "ws-connect-stalled",
        url: this.url,
        elapsedMs: Date.now() - startedAt,
        attempt,
      });
      this.detach(ws);
      ws.close();
      this.lost();
    }, CONNECT_DEADLINE_MS);

    ws.onopen = () => {
      this.clearConnectDeadline();
      this.attempt = 0;
      this.reconnect.reset();
      for (const data of this.queue.splice(0)) this.write(ws, data);
      this.events.onDiag({ type: "ws-open", url: this.url });
      this.setStatus("open", crypto.randomUUID());
    };
    ws.onmessage = (ev) => {
      this.events.onMessage(typeof ev.data === "string" ? ev.data : "");
    };
    ws.onerror = () => {
      this.events.onError();
    };
    ws.onclose = () => this.lost();
  };

  private clearConnectDeadline(): void {
    if (this.connectDeadline === null) return;
    clearTimeout(this.connectDeadline);
    this.connectDeadline = null;
  }

  private scheduleReconnect(): void {
    const attempt = this.reconnect.schedule(this.connect);
    this.events.onDiag({
      type: "ws-reconnect-scheduled",
      url: this.url,
      attempt,
    });
  }

  private write(ws: WebSocketLike, data: string): void {
    /* eslint-disable promise-safety/no-bare-catch -- a dead socket throws on send; its onclose drives the reconnect */
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
    /* eslint-enable promise-safety/no-bare-catch */
  }

  private setStatus(status: WsStatus, conn: string | null): void {
    this.status = status;
    this.conn = conn;
    this.events.onStatus(status, conn);
  }
}
