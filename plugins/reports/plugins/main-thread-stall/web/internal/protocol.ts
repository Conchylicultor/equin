// The tab ↔ watchdog-worker messages. Both ends ship in this plugin's web
// artifact (the worker script is content-addressed beside the tab code), so a
// tab only ever talks to a worker of its own build; `proto` is a tripwire.

import type { MainThreadStallPayload, StallFrame, StallTab } from "../../core";

/** Tab → worker. */
export type TabToWorker =
  /** First message on a port, sent once the tab holds its port lock. */
  | {
      kind: "attach";
      proto: number;
      portId: string;
      tab: StallTab;
      frozen: boolean;
    }
  | { kind: "pong" }
  /** Visibility, focus, route or Page Lifecycle freeze/resume changed. */
  | { kind: "state"; tab: StallTab; frozen: boolean }
  /** A long animation frame (≥ FRAME_POST_MIN_MS) just ended. */
  | { kind: "frame"; frame: StallFrame }
  /** The tab filed the stall it was handed (`ok: false`: it could not). */
  | { kind: "filed"; id: string; ok: boolean }
  /** pagehide / unmount: the port is leaving. */
  | { kind: "detach" };

/** Worker → tab. */
export type WorkerToTab =
  /**
   * Reply to `attach`: the watchdog's id. The tab queues for the watchdog's
   * lifetime lock — granted ⇒ the watchdog died (it lives in some tab's
   * renderer, and dies when that renderer is killed) ⇒ re-attach to a fresh one.
   */
  | { kind: "hello"; workerId: string }
  | { kind: "ping" }
  /** File this finished stall (the stalled tab may be gone, so a live one files it). */
  | { kind: "file"; id: string; payload: MainThreadStallPayload }
  /** A line for the main-thread-stall log channel (a worker has no clientLog). */
  | { kind: "log"; line: Record<string, unknown> }
  /** The worker cannot do its job (protocol mismatch, storage failed). */
  | { kind: "fatal"; message: string };
