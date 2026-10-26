import type { StatusDotPaint } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * The conversation-status vocabulary as a dot: the one mapping every surface
 * that shows a conversation's status reads, so a sidebar row, a chip and an
 * avatar's presence overlay cannot disagree.
 *
 * Live states are FILLED — `working` green, `waiting` (on you) amber. The
 * others are HOLLOW rings: `starting` (not live yet) muted, `gone` (its process
 * vanished) amber, `done` faint. Spread onto `<StatusDot>`; a surface drawing
 * its own dot element reads it through `statusDotPaintClass`.
 *
 * Its own module (not `conversation-item.tsx`) so the avatar fallback can read
 * it without the conversation-item ↔ slots import cycle.
 */
const CONV_STATUS_DOT: Record<ConversationStatus, StatusDotPaint> = {
  starting: { ringClass: "border-muted-foreground" },
  working: { colorClass: "bg-success" },
  waiting: { colorClass: "bg-warning" },
  gone: { ringClass: "border-warning" },
  done: { ringClass: "border-faint-foreground" },
};

/**
 * Unknown: the status reconciler could not check the row against the agent
 * (`statusUnverifiedSince`), so its status is only the last known one — a
 * filled muted dot (the agent is up; what it is doing is not known), never the
 * green or amber that would claim it.
 */
const UNVERIFIED_DOT: StatusDotPaint = { colorClass: "bg-muted-foreground" };

/** What a conversation's status dot reads: the status, and whether it is verified. */
type ConvStatusFacts = {
  status: ConversationStatus;
  statusUnverifiedSince: Date | null;
};

/**
 * A conversation's dot. Takes the row, not the status alone, so no surface can
 * paint an unverified status as fact. `done` is final, whatever the mark.
 */
export function convStatusDot(conv: ConvStatusFacts): StatusDotPaint {
  if (conv.statusUnverifiedSince !== null && conv.status !== "done")
    return UNVERIFIED_DOT;
  return CONV_STATUS_DOT[conv.status];
}

/**
 * The dot of a bare status, for a surface whose row carries no verification
 * mark — the agents' launch rollup (`latestConversationStatus`). It cannot show
 * Unknown; a surface with the conversation row uses {@link convStatusDot}.
 */
export function convStatusOnlyDot(status: ConversationStatus): StatusDotPaint {
  return CONV_STATUS_DOT[status];
}
