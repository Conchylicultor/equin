// The tab ↔ SharedWorker protocol behind `SharedWebSocket`. Both ends are built
// from the same networking artifact (the worker script is content-addressed next
// to the tab code that names it), so a tab only ever talks to a worker of its
// own build: `proto` is a loud tripwire for that invariant, not a negotiation.
// See `research/2026-10-08-networking-shared-worker-transport.md`.

import type { NetDiagEvent } from "./net-diag-bus";
import type { WsStatus } from "./ws-status-bus";

export const SHARED_WS_PROTO = 2;

/** Tab → worker. */
export type TabToWorker =
  /**
   * First message on a port, sent only once the tab holds its liveness lock.
   * `holdConnects`: an e2e test hook asked for a socket that never connects
   * (see `core/ws-test-hook.ts`); false in every real session.
   */
  | {
      kind: "attach";
      url: string;
      portId: string;
      proto: number;
      holdConnects: boolean;
    }
  /** A frame for the server. */
  | { kind: "tx"; data: string }
  /** The frame the worker sends the server when this port leaves; `null` clears it. */
  | { kind: "will"; data: string | null }
  /** The tab is leaving (pagehide / close): release the port now. */
  | { kind: "detach" }
  /** A fault injected by an e2e test hook (`core/ws-test-hook.ts`); never sent otherwise. */
  | { kind: "test-fault"; fault: SocketFault };

/** The faults `SocketOwner` can be told to simulate. */
export type SocketFault = "drop" | "hold" | "release";

/** Worker → tab. */
export type WorkerToTab =
  /**
   * The shared socket's state — sent in reply to `attach` and on every
   * transition. `conn` names the server connection while `status` is "open"
   * (a fresh id per real open: consumers replay their state once per `conn`).
   */
  | { kind: "status"; status: WsStatus; conn: string | null; ports: number }
  /** A server frame, fanned out to every port (consumers filter their own). */
  | { kind: "rx"; data: string }
  /** The real socket fired `error`. */
  | { kind: "ws-error" }
  /** A diagnostic event for the tab's net-diag bus (the worker has no bus). */
  | { kind: "diag"; event: NetDiagEvent }
  /** The worker rejected this port (protocol or URL mismatch). */
  | { kind: "fatal"; message: string }
  /**
   * The worker released this port as "gone" (it was granted the port's
   * liveness lock) — sent to the released port itself, just before the worker
   * closes it, so a tab that is in fact alive learns it was dropped instead of
   * sending into a port nobody reads.
   */
  | { kind: "released"; attachedMs: number };

/**
 * The SharedWorker name for one server URL and dialect. SharedWorker identity
 * is (script URL, name), so each URL gets its own worker — and its own socket
 * — and so does each dialect of it (see `SharedWebSocketOptions.dialect`).
 */
export function sharedWsWorkerName(absUrl: string, dialect?: string): string {
  return dialect === undefined
    ? `singularity:shared-ws:${absUrl}`
    : `singularity:shared-ws:${absUrl}:${dialect}`;
}

/**
 * The Web Lock a tab holds for a port's whole life. The worker queues for the
 * same name: being granted it means the tab is gone (closed, crashed, killed),
 * the one signal a SharedWorker gets — `MessagePort` has no portable close event.
 */
export function portLivenessLockName(portId: string): string {
  return `singularity:shared-ws-port:${portId}`;
}
