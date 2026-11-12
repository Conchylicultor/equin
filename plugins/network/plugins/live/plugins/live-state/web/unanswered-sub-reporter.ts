import type { AnswerTrail } from "@plugins/network/plugins/live/plugins/resource-protocol/core";
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
  /**
   * Where the server stands on the oldest one, asked of it before reporting
   * (`UnansweredTrail`) — the split of the wait between that server's thread,
   * its read gate and the read's own load, and the way back.
   */
  trail: UnansweredTrail;
}

/**
 * The server's answer trail for the oldest unanswered sub (resource-protocol's
 * `AnswerTrail`), asked over the same transport the sub went out on, with the
 * tab's own instants beside it (wall clock, like the trail's):
 * - `trail` — the server answered: `sentAt` the sub frame left this tab,
 *   `askedAt` the question did, `repliedAt` its answer arrived;
 * - `silent` — no answer within `ANSWER_TRAIL_WAIT_MS` (`waitedMs`): the
 *   server's thread, or the link to it, is stuck — the report says so rather
 *   than waiting on it;
 * - `failed` — the question itself failed (`message`): a server that predates
 *   the trail (404), a broken link.
 */
export type UnansweredTrail =
  | {
      kind: "trail";
      trail: AnswerTrail;
      sentAt: number;
      askedAt: number;
      repliedAt: number;
    }
  | { kind: "silent"; waitedMs: number }
  | { kind: "failed"; message: string };

/**
 * How long a tab waits for the trail before reporting without it: the
 * question goes to a server that already left a sub unanswered, so its
 * silence is itself the answer — a bound on a peer, never a retry.
 */
export const ANSWER_TRAIL_WAIT_MS = 10_000;

const s = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/**
 * The trail in words, for a report's detail: the sub's way in (was the frame
 * read, and how long after it was sent), its read (queued for a read-admission
 * slot, loading), the gate it queued at (occupancy and who holds it), the way
 * out (an answer that left and never arrived), and how long the server's
 * thread took to answer this very question.
 */
export function describeUnansweredTrail(t: UnansweredTrail): string {
  switch (t.kind) {
    case "silent":
      return `server did not answer the answer-trail question within ${s(t.waitedMs)} (its thread or the link to it is stuck)`;
    case "failed":
      return `answer-trail question failed: ${t.message}`;
    case "trail": {
      const { trail } = t;
      const parts: string[] = [];
      const r = trail.request;
      switch (r.kind) {
        case "no-record":
          parts.push(
            `server never read the sub frame (sent ${s(trail.at - t.sentAt)} before the question was served)`,
          );
          break;
        case "received":
          parts.push(
            `server read the sub ${s(r.at - t.sentAt)} after send, unanswered for ${s(trail.at - r.at)}`,
          );
          break;
        case "answered":
          parts.push(
            `server read the sub ${s(r.receivedAt - t.sentAt)} after send and sent its ${r.frame} ${s(r.at - r.receivedAt)} later, ${
              r.at <= t.askedAt
                ? `${s(t.askedAt - r.at)} before this tab gave up — delayed or lost on the way back`
                : `${s(r.at - t.askedAt)} after this tab gave up — slow, not lost`
            }`,
          );
          break;
      }
      if (trail.queued !== null) {
        parts.push(
          `queued for a read slot ${s(trail.at - trail.queued.since)}${trail.queued.probe ? " (revalidate probe)" : ""}`,
        );
      }
      if (trail.loading !== null) {
        parts.push(`loading ${s(trail.at - trail.loading.since)}`);
      }
      const g = trail.gate;
      parts.push(
        `read gate ${g.active}/${g.max} held, ${g.queued} queued${
          g.holders.length > 0
            ? `; holders: ${g.holders.map((h) => `${h.label} ${s(h.heldMs)}`).join(", ")}`
            : ""
        }`,
      );
      parts.push(
        `question served ${s(trail.at - t.askedAt)} after asked, answered here ${s(t.repliedAt - t.askedAt)} after`,
      );
      return parts.join("; ");
    }
  }
}

export const unansweredSubReportSink = defineReportSink<UnansweredSubReport>();
