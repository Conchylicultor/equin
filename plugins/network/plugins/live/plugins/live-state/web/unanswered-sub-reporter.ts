import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { TransportServer } from "@plugins/primitives/plugins/networking/web";
import type { LiveStateSocketKind } from "./notifications-client";

/**
 * The server a sub went unanswered by — each its own fault domain:
 * `worktree` (this checkout's backend, the page's own server), `central` (the
 * process every worktree shares) or `in-browser` (a server running in this
 * browser — a browser host's worker graph, reached through its transport).
 */
export type UnansweredServer = "worktree" | "central" | "in-browser";

/**
 * Which server a channel's socket reaches: its central socket is central's;
 * its worktree socket is the transport's server — the page's backend, or one
 * running in this browser. A transport with no server opens no socket, so it
 * can leave nothing unanswered.
 */
export function unansweredServer(
  socket: LiveStateSocketKind,
  server: TransportServer,
): UnansweredServer {
  if (socket === "central") return "central";
  switch (server) {
    case "page":
      return "worktree";
    case "in-browser":
      return "in-browser";
    case "none":
      throw new Error(
        "[live-state] a sub went unanswered over a transport with no server — it opens no socket",
      );
  }
}

/**
 * Subscriptions this tab sent on an OPEN socket that got no answer — no
 * `sub-ack`, `up-to-date` or `sub-error` — within `UNANSWERED_SUB_MS`. The
 * server answers every sub it receives (registration is synchronous on
 * receipt), so an unanswered one means the frame never reached it, or the answer
 * never reached this tab: the transport between them is broken while still
 * reporting "open". Emitted once per stuck sub (the batch is everything that
 * crossed the deadline together); live-state never recovers on its own here —
 * the consumer (infra/health's watchdog) reports it. Emitted only when the
 * client's transport reports its telemetry.
 */
export interface UnansweredSubReport {
  /** The server that left them unanswered. */
  server: UnansweredServer;
  /** How many subs crossed the deadline together. */
  count: number;
  /** The oldest of them: key, params and how long it has waited. */
  oldestKey: string;
  oldestParams: string;
  oldestWaitMs: number;
  /** The transport's view: tabs on the shared socket and this tab's connection id. */
  attachedTabs: number | null;
  connection: string | null;
}

export const unansweredSubReportSink = defineReportSink<UnansweredSubReport>();
