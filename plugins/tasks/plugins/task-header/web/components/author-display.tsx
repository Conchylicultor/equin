import { rowOrStale } from "@plugins/network/plugins/live/web";
import { useConversationById } from "@plugins/conversations/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useTask } from "@plugins/tasks/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import type { TaskAuthorKind } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * Who filed the task (`TaskAuthor`): "You", the filing agent's task (linked),
 * or "System" with the plugin that filed it.
 */
export function AuthorDisplay({
  authorKind,
  authorConversationId,
  filedFrom,
}: {
  authorKind: TaskAuthorKind;
  authorConversationId: string | null;
  filedFrom: string | null;
}) {
  if (authorKind === "human") return <Text variant="body">You</Text>;
  if (authorKind === "system") {
    return (
      <Text variant="body">
        System
        {filedFrom !== null ? (
          <Text as="span" variant="caption" tone="muted" className="font-mono">
            {` · ${filedFrom}`}
          </Text>
        ) : null}
      </Text>
    );
  }
  if (authorConversationId === null) {
    throw new Error("AuthorDisplay: an agent author has no conversation id");
  }
  return <AgentAuthor conversationId={authorConversationId} />;
}

function AgentAuthor({ conversationId }: { conversationId: string }) {
  const authorConversation = rowOrStale(useConversationById(conversationId));
  const authorTask = useTask(authorConversation?.taskId);
  const openPane = useOpenPane();

  // Until the author's task is known — or when it could not be read, or the
  // author conversation has no task — the raw author id stands in: it is the
  // true value, just not linked. A failed read also says so on hover.
  const row = foldResource(authorTask, {
    loading: () => null,
    error: () => null,
    ready: (t) => t,
  });
  if (row === null) {
    return (
      <Text
        variant="caption"
        tone="muted"
        className="font-mono"
        title={
          authorTask.status === "error"
            ? `Couldn't load the author's task: ${authorTask.error.message}`
            : undefined
        }
      >
        {conversationId}
      </Text>
    );
  }

  return (
    <button
      type="button"
      {...openPane.link(taskDetailPane, { taskId: row.id }, { mode: "swap" })}
      className="text-body hover:text-foreground underline underline-offset-2"
    >
      {row.title}
    </button>
  );
}
