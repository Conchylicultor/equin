// Network-diagnostics event bus. Mirrors ws-status-bus.ts: a module-level
// listener Set with publish/subscribe. The networking layer only *publishes*
// transition events here (shared-websocket republishes the events its
// SharedWorker reports, since the worker realm has no bus of its own); a
// subscriber living *above* networking (live-state) forwards them to the
// persistent log channel. This keeps networking free of any log-channels
// dependency, avoiding the networking ↔ log-channels import cycle.

export type NetDiagEvent =
  // --- socket lifecycle (socket-owner.ts, inside the SharedWorker) ---
  | { type: "ws-open"; url: string }
  | { type: "ws-close"; url: string }
  | { type: "ws-reconnect-scheduled"; url: string; attempt: number }
  /**
   * A connection attempt neither opened nor closed within the connect deadline
   * (`CONNECT_DEADLINE_MS`): the handshake hung. The owner abandons it and
   * reconnects — this event is the record that it happened, so the stall is
   * reported, never just healed. `attempt`: 0 for a first connect.
   */
  | {
      type: "ws-connect-stalled";
      url: string;
      elapsedMs: number;
      attempt: number;
    }
  // --- tab ports joining / leaving the SharedWorker (shared-ws-host.ts) ---
  | { type: "port-attached"; url: string; ports: number }
  | {
      type: "port-released";
      url: string;
      ports: number;
      reason: "detach" | "gone";
      /** How long the released port had been attached. */
      attachedMs: number;
    }
  /**
   * Published by the TAB (shared-websocket.ts) whose own port the worker
   * released as "gone" while the tab was alive — the worker was granted the
   * tab's liveness lock. `tabLock` is what the tab's own lock request says at
   * that moment, which names the trigger: `"held"` ⇒ the worker was granted a
   * lock the tab still holds (a Web Locks fault); `"ended"` ⇒ the tab's hold
   * ended without the tab releasing it; `"aborted:<DOMException name>"` ⇒ the
   * browser rejected the tab's request (e.g. stolen). The tab re-attaches
   * after publishing.
   */
  | {
      type: "port-evicted";
      url: string;
      attachedMs: number;
      tabLock: "held" | "ended" | `aborted:${string}`;
    };

type Listener = (ev: NetDiagEvent) => void;

const listeners = new Set<Listener>();

export function publishNetDiag(ev: NetDiagEvent): void {
  for (const fn of listeners) fn(ev);
}

export function subscribeNetDiag(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
