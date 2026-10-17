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
  /** `Date.now()` at attach — how long a released port had lived. */
  attachedAt: number;
}

/**
 * The SharedWorker's logic, free of worker globals so tests run it in-process
 * (`shared-ws.worker.ts` is the thin entry wiring the real ones).
 *
 * One host = one server URL (the worker's name). It owns the single socket for
 * that URL while at least one tab port is attached, fans every server frame out
 * to every port, and writes every port's frames to the socket. A port leaves by
 * `detach`, or — when its tab dies without saying so — when the worker is
 * granted the tab's liveness lock; either way its will (if any) goes to the
 * server. The last port leaving closes the socket.
 */
export function createSharedWsHost(deps: SharedWsHostDeps): SharedWsHost {
  let url: string | null = null;
  let owner: SocketOwner | null = null;
  const ports = new Map<string, PortEntry>();

  const post = (port: MessagePortLike, msg: WorkerToTab): void => {
    port.postMessage(msg);
  };
  const broadcast = (msg: WorkerToTab): void => {
    for (const { port } of ports.values()) post(port, msg);
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
    url = msg.url;
    ports.set(msg.portId, { port, will: null, attachedAt: Date.now() });
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
      owner = new SocketOwner(socketUrl, deps.makeWebSocket, {
        onStatus: () => broadcastStatus(),
        onMessage: (data) => broadcast({ kind: "rx", data }),
        onError: () => broadcast({ kind: "ws-error" }),
        onDiag: diag,
      });
      if (msg.holdConnects) owner.fault("hold");
      owner.start();
    }
    return msg.portId;
  };

  return {
    connect(port) {
      let portId: string | null = null;
      port.onmessage = (ev: MessageEvent<TabToWorker>) => {
        const msg = ev.data;
        if (portId === null) {
          if (msg.kind !== "attach") {
            fatal(port, `shared-ws: expected attach, got ${msg.kind}`);
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
