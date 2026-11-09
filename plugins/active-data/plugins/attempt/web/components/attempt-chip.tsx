import { mapRow, rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  mapResource,
  matchResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { IdReferentState } from "@plugins/ids/web";
import {
  paneTarget,
  usePaneToggle,
  type PaneTarget,
} from "@plugins/primitives/plugins/pane/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { attemptPane } from "@plugins/tasks/plugins/attempt-view/web";
import {
  attemptRows,
  taskRows,
  type AttemptWithConversations,
  type ConversationSummary,
  type TaskRow,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  ATTEMPT_STATUS_META,
  attemptStatusLabel,
} from "@plugins/tasks/plugins/attempt-status/web";

// The dot tint and its wording come from attempt-status, the one owner of
// AttemptStatus display metadata. This chip used to author its own map, which
// had drifted: it painted `pushed` as success and `completed` as categorical-5
// while the badge painted them info and success — so the same attempt told two
// different stories depending on which surface you were looking at.
const UNKNOWN_DOT = "bg-muted-foreground/40";

/** The conversation the attempt was launched with — the earliest one. */
function firstConversation(
  attempt: AttemptWithConversations,
): ConversationSummary | undefined {
  let first: ConversationSummary | undefined;
  for (const c of attempt.conversations) {
    if (!first || c.createdAt < first.createdAt) first = c;
  }
  return first;
}

/**
 * The attempt and its task's row, both live point reads — the chip names one
 * attempt and one task, it needs neither whole set. The ready arm is `null`
 * for an attempt that does not exist; `task` is `null` for a task the list no
 * longer holds.
 */
function useAttemptWithTask(attemptId: string): ResourceResult<{
  attempt: AttemptWithConversations;
  task: TaskRow | null;
} | null> {
  const read = useLive(attemptRows, { id: attemptId });
  const attempt = mapRow(read, (row) => row);
  const task = mapRow(
    useLive(taskRows, { id: rowOrStale(read)?.taskId ?? null }),
    (row) => row,
  );
  return mapResource(
    useCombinedResources({ attempt, task }),
    ({ attempt: row, task: taskRow }) =>
      row ? { attempt: row, task: taskRow } : null,
  );
}

export function AttemptChip({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  const attemptId = content.trim();
  const result = useAttemptWithTask(attemptId);
  const activation = usePaneToggle()(useAttemptPane(attemptId));

  if (!attemptId) return null;

  // The degraded raw-id chip: shown while loading, and for an attempt the
  // index doesn't hold, so the chip never disappears.
  const rawChip = (
    <LinkChip
      activation={activation}
      tooltip={attemptId}
      leading={<StatusDot colorClass={UNKNOWN_DOT} />}
      mono
    >
      {attemptId}
    </LinkChip>
  );

  return matchResource(result, {
    loading: () => rawChip,
    ready: (found) => {
      if (!found) return rawChip;
      const { attempt, task } = found;
      const conv = firstConversation(attempt);
      // Named after the conversation it opens; the task title covers the
      // window before that conversation has a title (or when it has none).
      const name = conv?.title?.trim() || task?.title.trim() || undefined;
      const count = attempt.conversations.length;
      return (
        <LinkChip
          activation={activation}
          tooltip={[name, attemptStatusLabel(attempt.status), attemptId]
            .filter(Boolean)
            .join(" · ")}
          leading={
            <StatusDot
              colorClass={ATTEMPT_STATUS_META[attempt.status].dotClass}
            />
          }
          mono={!name}
        >
          {name ?? attemptId}
          {count > 1 && (
            <span className="text-muted-foreground/70">{count}</span>
          )}
        </LinkChip>
      );
    },
  });
}

/**
 * The attempt presenter's referent read — what the chip names it: its first
 * conversation's title, else its task's title, else the id itself.
 */
export function useAttemptReferent(attemptId: string): IdReferentState {
  const result = useAttemptWithTask(attemptId);
  return foldResource(result, {
    loading: (): IdReferentState => ({ status: "loading" }),
    error: (error): IdReferentState => ({ status: "failed", error }),
    ready: (found): IdReferentState => {
      if (!found) return { status: "missing" };
      const { attempt, task } = found;
      const title =
        firstConversation(attempt)?.title?.trim() ||
        task?.title.trim() ||
        attemptId;
      return { status: "found", title };
    },
  });
}

/**
 * The pane an attempt opens in: its first conversation — most attempts hold a
 * single one, so the chip goes straight to it instead of stopping at the
 * attempt pane's list of one — else the attempt pane. Until the attempt is
 * read (or when it is gone) it is the attempt pane, which answers both itself.
 * Either way a column to the right, like every other chip: opening the
 * attempt pane on the LEFT of a conversation is the conversation toolbar's
 * attempt-switch toggle alone.
 */
export function useAttemptPane(attemptId: string): PaneTarget {
  const attempt = rowOrStale(useLive(attemptRows, { id: attemptId }));
  const conv = attempt ? firstConversation(attempt) : undefined;
  return conv
    ? paneTarget(conversationPane, { convId: conv.id })
    : paneTarget(attemptPane, { attemptId });
}
