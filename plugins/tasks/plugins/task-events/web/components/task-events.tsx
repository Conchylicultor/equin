import { useLive } from "@plugins/network/plugins/live/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { ConversationRow } from "@plugins/conversations/plugins/conversation-ui/plugins/row/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { repoInfo } from "@plugins/tasks/core";
import { pushRows } from "@plugins/tasks/plugins/tasks-core/core";
import type { Push } from "@plugins/tasks/plugins/tasks-core/core";
import { useTaskAttempts } from "@plugins/tasks/plugins/tasks-core/web";
import { AttemptStatusBadge } from "@plugins/tasks/plugins/attempt-status/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { NewTabGlyph } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

function formatDate(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PushRow({
  push,
  githubBase,
}: {
  push: Push;
  githubBase: string | null;
}) {
  const short = push.sha.slice(0, 7);
  const url = githubBase ? `${githubBase}/commit/${push.sha}` : null;
  return (
    <li>
      <Row
        href={url ?? undefined}
        target={url ? "_blank" : undefined}
        rel={url ? "noreferrer" : undefined}
        bordered
        className="gap-md"
      >
        <Text
          as="code"
          variant="caption"
          tone="muted"
          className={cn(rigidClass(), "font-mono")}
        >
          {short}
        </Text>
        <Fill as="span">
          <Text as="span" variant="body">
            {push.message}
          </Text>
        </Fill>
        <Text
          as="span"
          variant="caption"
          tone="muted"
          className={cn(rigidClass(), "tabular-nums")}
        >
          {formatDate(push.createdAt)}
        </Text>
        {url ? (
          <NewTabGlyph
            className={cn("text-muted-foreground size-4", rigidClass())}
          />
        ) : null}
      </Row>
    </li>
  );
}

// One attempt's pushes: the `pushes` collection filtered to this attempt (a
// filter, not a slice of a global window, so it is correct for arbitrarily old
// attempts). Rendered once per attempt so a task's push history is grouped by
// attempt — attempts arrive newest-first, and the collection's default order is
// `createdAt` desc, so pushes within an attempt do too. Renders nothing until
// the rows are known: the parent already showed its loading state for the
// attempts, and an attempt's pushes land a round trip later.
function AttemptPushList({
  attemptId,
  githubBase,
}: {
  attemptId: string;
  githubBase: string | null;
}) {
  const pushesQ = useLive(pushRows, { where: { attemptId } });
  if (pushesQ.status === "loading") return null;
  if (pushesQ.status === "error") {
    return (
      <li>
        <ResourceErrorInline
          variant="inline"
          subject="this attempt's pushes"
          error={pushesQ.error}
          refetch={pushesQ.refetch}
        />
      </li>
    );
  }
  return (
    <>
      {pushesQ.data.map((push) => (
        <PushRow key={push.id} push={push} githubBase={githubBase} />
      ))}
    </>
  );
}

/**
 * A task with no attempts has neither pushes nor attempts to list. Declared as
 * both contributions' `useAvailable` rather than an empty-state placeholder in
 * the body: the host paints the card before it reaches the body, so "No pushes
 * yet." is a titled bar the user opens onto nothing.
 */
export function useHasTaskAttempts({ taskId }: { taskId: string }): boolean {
  const attempts = useTaskAttempts(taskId);
  // A failed read keeps the card painted: its body renders the failure.
  return foldResource(attempts, {
    loading: () => false,
    error: () => true,
    ready: (list) => list.length > 0,
  });
}

export function TaskPushes({ taskId }: { taskId: string }) {
  const attempts = useTaskAttempts(taskId);
  // Where a push row links its sha: not known yet is loading, never a row
  // rendered without its link that gains one a round trip later.
  const repo = useLive(repoInfo);

  if (attempts.status === "loading" || repo.status === "loading") {
    return <Loading variant="rows" />;
  }
  if (attempts.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the pushes"
        error={attempts.error}
        refetch={attempts.refetch}
      />
    );
  }
  if (repo.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the repository's GitHub address"
        error={repo.error}
        refetch={repo.refetch}
      />
    );
  }
  const githubBase = repo.data.githubBase;
  if (attempts.data.length === 0) {
    return (
      <Text as="p" variant="body" tone="muted">
        No pushes yet.
      </Text>
    );
  }

  return (
    <Stack as="ul" gap="xs">
      {attempts.data.map((a) => (
        <AttemptPushList key={a.id} attemptId={a.id} githubBase={githubBase} />
      ))}
    </Stack>
  );
}

export function TaskAttempts({ taskId }: { taskId: string }) {
  const attempts = useTaskAttempts(taskId);
  const opener = useConversationOpener();

  if (attempts.status === "loading") return <Loading variant="rows" />;
  if (attempts.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the attempts"
        error={attempts.error}
        refetch={attempts.refetch}
      />
    );
  }
  if (attempts.data.length === 0) {
    return (
      <Text as="p" variant="body" tone="muted">
        No attempts yet.
      </Text>
    );
  }

  return (
    <Stack as="ul" gap="sm">
      {attempts.data.map((attempt) => {
        const convs = attempt.conversations;
        return (
          <Stack
            as="li"
            key={attempt.id}
            gap="sm"
            className="rounded-md border px-md py-sm"
          >
            <Line className="gap-md">
              <AttemptStatusBadge status={attempt.status} />
              <Fill as="span">
                <Text className="text-caption font-mono text-muted-foreground">
                  {attempt.worktreePath.split("/").pop()}
                </Text>
              </Fill>
              <Text
                as="span"
                variant="caption"
                tone="muted"
                className={cn(rigidClass(), "tabular-nums")}
              >
                {formatDate(attempt.createdAt)}
              </Text>
            </Line>
            {convs.length === 0 ? (
              <Text as="p" variant="caption" tone="muted" className="pl-xs">
                No conversations.
              </Text>
            ) : (
              <Stack as="ul" gap="xs">
                {convs.map((c) => (
                  <li key={c.id}>
                    <ConversationRow
                      conv={c}
                      actions={
                        <IconButton
                          icon={navIcons.expand}
                          label="Open as page"
                          tooltip="Open in a new page"
                          {...activationProps(opener.asPage(c.id))}
                        />
                      }
                    />
                  </li>
                ))}
              </Stack>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
