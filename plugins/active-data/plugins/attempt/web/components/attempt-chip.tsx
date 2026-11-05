import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  mapResource,
  matchResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { IdReferentState } from "@plugins/ids/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
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
 * The attempt and its task's row, both live: the attempt out of the attempt
 * set, its task by id (a point read — the chip names one task, it does not
 * need the whole task set). The ready arm is `null` for an attempt the set
 * does not hold; `task` is `null` for a task the list no longer holds.
 */
function useAttemptWithTask(attemptId: string): ResourceResult<{
  attempt: AttemptWithConversations;
  task: TaskRow | null;
} | null> {
  const attempts = useLive(attemptRows);
  const taskId = foldResource(attempts, {
    loading: () => null,
    error: () => null,
    ready: (rows) => rows.find((a) => a.id === attemptId)?.taskId ?? null,
  });
  const task = mapRow(useLive(taskRows, { id: taskId }), (row) => row);
  return mapResource(
    useCombinedResources({ attempts, task }),
    ({ attempts: rows, task: row }) => {
      const attempt = rows.find((a) => a.id === attemptId);
      return attempt ? { attempt, task: row } : null;
    },
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
  const openPane = useOpenPane();
  const opener = useConversationOpener();

  if (!attemptId) return null;

  // Most attempts hold a single conversation, so the chip goes straight to
  // the first one instead of stopping at the attempt pane's list of one. The
  // attempt pane stays the target only when there is no conversation to open.
  // Either way it is a regular push to the right, like every other chip —
  // opening the attempt pane on the LEFT of a conversation is the
  // conversation toolbar's attempt-switch toggle alone.
  const target = (convId: string | undefined): LinkTarget =>
    convId
      ? opener.toggle(convId)
      : openPane.to(attemptPane, { attemptId }, { mode: "push" });

  // The degraded raw-id chip: shown while loading, and for an attempt the
  // index doesn't hold, so the chip never disappears.
  const rawChip = (
    <LinkChip
      activation={target(undefined)}
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
          activation={target(conv?.id)}
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
 * The link to an attempt, the way its chip opens it: its first conversation
 * (most attempts hold one), else the attempt pane — a push beside the surface
 * holding the id.
 */
export function useAttemptTarget(): (attemptId: string) => LinkTarget {
  const attempts = useLive(attemptRows);
  const openPane = useOpenPane();
  const opener = useConversationOpener();
  return (attemptId) => {
    const attempt = foldResource(attempts, {
      loading: () => undefined,
      error: () => undefined,
      ready: (rows) => rows.find((a) => a.id === attemptId),
    });
    const conv = attempt ? firstConversation(attempt) : undefined;
    return conv
      ? opener.toggle(conv.id)
      : openPane.to(attemptPane, { attemptId }, { mode: "push" });
  };
}
