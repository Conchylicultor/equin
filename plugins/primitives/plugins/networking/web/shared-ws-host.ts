import { readFrameAddress } from "./addressed-frame-reader";
import type { NetDiagEvent } from "./net-diag-bus";
import {
  SHARED_WS_PROTO,
  portLivenessLockName,
  type TabToWorker,
  type WorkerToTab,
} from "./shared-ws-protocol";
import { SocketOwner } from "./socket-owner";
import type {
  LockManagerLike,
  MakeWebSocket,
  MessagePortLike,
} from "./transport-types";

export interface SharedWsHostDeps {
  makeWebSocket: MakeWebSocket;
  locks: LockManagerLike;
}

export interface SharedWsHost {
  /** A tab connected (the SharedWorker's `connect` event): serve this port. */
  connect(port: MessagePortLike): void;
}

interface PortEntry {
  port: MessagePortLike;
  will: string | null;
  /** The port's address (`attach.address`): which addressed frames reach it. */
  address: string | null;
  /** `Date.now()` at attach — how long a released port had lived. */
  attachedAt: number;
}

/**
 * The SharedWorker's logic, free of worker globals so tests run it in-process
 * (`shared-ws.worker.ts` is the thin entry wiring the real ones).
 *
 * One host = one server URL (the worker's name). It owns the single socket for
 * that URL while at least one tab port is attached, hands every server frame to
 * the ports it is for — an unaddressed one to every port, an addressed one
 * (`core/addressed-frame.ts`) to the ports whose address it names, so a tab
 * never receives a frame answering another tab — and writes every port's
 * frames to the socket. A port leaves by
 * `detach`, or — when its tab dies without saying so — when the worker is
 * granted the tab's liveness lock; either way its will (if any) goes to the
 * server. The last port leaving closes the socket.
 */
export function createSharedWsHost(deps: SharedWsHostDeps): SharedWsHost {
  let url: string | null = null;
  /** The server's heartbeat, as the attach that opened the socket named it. */
  let heartbeatMs: number | null = null;
  let owner: SocketOwner | null = null;
  const ports = new Map<string, PortEntry>();

  const post = (port: MessagePortLike, msg: WorkerToTab): void => {
    port.postMessage(msg);
  };
  const broadcast = (msg: WorkerToTab): void => {
    for (const { port } of ports.values()) post(port, msg);
  };
  // Reading the address is two `indexOf`s: the body is never parsed here.
  const deliverRx = (data: string): void => {
    const arrivedAt = Date.now();
    const { to, body } = readFrameAddress(data);
    if (to === null) {
      broadcast({ kind: "rx", data: body, arrivedAt });
      return;
    }
    for (const entry of ports.values()) {
      if (entry.address !== null && to.includes(entry.address)) {
        post(entry.port, { kind: "rx", data: body, arrivedAt });
      }
    }
  };
  const diag = (event: NetDiagEvent): void => {
    broadcast({ kind: "diag", event });
  };
  const broadcastStatus = (): void => {
    if (!owner) return;
    broadcast({
      kind: "status",
      status: owner.status,
      conn: owner.conn,
      ports: ports.size,
    });
  };

  const fatal = (port: MessagePortLike, message: string): void => {
    post(port, { kind: "fatal", message });
    port.close();
  };

  const release = (portId: string, reason: "detach" | "gone"): void => {
    const entry = ports.get(portId);
    if (!entry) return; // already released (detach, then the lock frees)
    ports.delete(portId);
    const attachedMs = Date.now() - entry.attachedAt;
    // "gone" is the worker's inference (it was granted the tab's liveness
    // lock), not the tab's word. Tell the port itself before closing it: a tab
    // that is in fact alive learns it was dropped, reports why, and re-attaches
    // — instead of sending into a port nobody reads, forever.
    if (reason === "gone") post(entry.port, { kind: "released", attachedMs });
    entry.port.close();
    if (entry.will !== null) owner?.sendIfOpen(entry.will);
    diag({
      type: "port-released",
      url: url!,
      ports: ports.size,
      reason,
      attachedMs,
    });
    if (ports.size === 0) {
      owner?.close();
      owner = null;
      return;
    }
    broadcastStatus();
  };

  const attach = (
    port: MessagePortLike,
    msg: Extract<TabToWorker, { kind: "attach" }>,
  ): string | null => {
    if (msg.proto !== SHARED_WS_PROTO) {
      fatal(
        port,
        `shared-ws protocol mismatch: tab speaks ${msg.proto}, worker ${SHARED_WS_PROTO}`,
      );
      return null;
    }
    if (url !== null && msg.url !== url) {
      fatal(
        port,
        `shared-ws worker serves ${url}, tab attached for ${msg.url}`,
      );
      return null;
    }
    if (owner !== null && msg.heartbeatMs !== heartbeatMs) {
      fatal(
        port,
        `shared-ws worker's socket judges a ${heartbeatMs ?? "no"} ms heartbeat, tab attached for ${msg.heartbeatMs ?? "none"}`,
      );
      return null;
    }
    url = msg.url;
    ports.set(msg.portId, {
      port,
      will: null,
      address: msg.address,
      attachedAt: Date.now(),
    });
    // Granted only once the tab's own hold ends: the tab is gone.
    void deps.locks.request(
      portLivenessLockName(msg.portId),
      { mode: "exclusive" },
      () => release(msg.portId, "gone"),
    );
    diag({ type: "port-attached", url, ports: ports.size });
    if (owner) {
      if (msg.holdConnects) owner.fault("hold");
      broadcastStatus();
    } else {
      const socketUrl = url;
      heartbeatMs = msg.heartbeatMs;
      owner = new SocketOwner(
        socketUrl,
        deps.makeWebSocket,
        {
          onStatus: () => broadcastStatus(),
          // Stamped here, in the worker: a busy tab delays only its own
          // handler, never this.
          onMessage: deliverRx,
          onError: () => broadcast({ kind: "ws-error" }),
          onDiag: diag,
        },
        heartbeatMs,
      );
      if (msg.holdConnects) owner.fault("hold");
      owner.start();
    }
    return msg.portId;
  };

  return {
    connect(port) {
      let portId: string | null = null;
      /** The port's first message was not `attach` (see below). */
      let orphaned = false;
      port.onmessage = (ev: MessageEvent<TabToWorker>) => {
        const msg = ev.data;
        if (orphaned) return; // told once; the tab re-attaches on a new port
        if (portId === null) {
          if (msg.kind !== "attach") {
            // A port that attached to an EARLIER instance of this worker: the
            // browser restarted the worker and handed it the port it already
            // had (WebKit relaunches a terminated SharedWorker for the
            // SharedWorker objects still alive, re-sending `connect` with
            // their ports). This instance has no attach for it — tell the tab
            // to attach again, on a fresh port.
            orphaned = true;
            if (msg.kind !== "detach") {
              post(port, { kind: "orphaned", first: msg.kind });
            }
            port.close();
            return;
          }
          portId = attach(port, msg);
          return;
        }
        const entry = ports.get(portId);
        if (!entry) return; // released; late frames from a departing tab
        switch (msg.kind) {
          case "tx":
            owner?.send(msg.data);
            return;
          case "will":
            entry.will = msg.data;
            return;
          case "detach":
            release(portId, "detach");
            return;
          case "check-link":
            owner?.checkLink();
            return;
          case "replace-connection":
            owner?.replaceConnection(msg.conn);
            return;
          case "test-fault":
            owner?.fault(msg.fault);
            return;
          case "attach":
            fatal(port, "shared-ws: port attached twice");
            return;
        }
      };
    },
  };
}
