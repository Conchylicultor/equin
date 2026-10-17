import { useLive } from "@plugins/network/plugins/live/web";
import {
  Button,
  ButtonGroup,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, useMemo, useCallback } from "react";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { useActiveConversations } from "@plugins/conversations/web";
import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { addTaskDependency, removeTaskDependency } from "@plugins/tasks/core";
import {
  taskRows,
  TaskGraph,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  fetchEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import { toast } from "@plugins/shell/plugins/notifications/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import {
  WithHoverCard,
  type HoverCardContent,
} from "@plugins/primitives/plugins/overlay/plugins/hover-card/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { DepPopoverContent } from "./dep-popover-content";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const linkIcon = symbol("link");

export function DependenciesButton({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  const tasksResult = useLive(taskRows);
  const activeResult = useActiveConversations();
  const combined = useCombinedResources({
    tasks: tasksResult,
    active: activeResult,
  });
  if (combined.status === "loading") return null;
  if (combined.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        icon={linkIcon}
        subject="the dependencies"
        error={combined.error}
        refetch={combined.refetch}
      />
    );
  return (
    <DependenciesButtonInner
      conversation={conversation}
      allTasks={combined.data.tasks}
      active={combined.data.active}
    />
  );
}

function DependenciesButtonInner({
  conversation,
  allTasks,
  active,
}: {
  conversation: ConversationRecord;
  allTasks: TaskListItem[];
  active: ConversationRecord[];
}) {
  const [blockedByOpen, setBlockedByOpen] = useState(false);
  const [blockingOpen, setBlockingOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // The task list is already known here (the outer gate), so the task is a
  // plain lookup — absent only when the list really holds no such task.
  const task = useMemo(
    () => allTasks.find((t) => t.id === conversation.taskId) ?? null,
    [allTasks, conversation.taskId],
  );

  const depTaskIds = useMemo(
    () => new Set(task?.dependencies ?? []),
    [task?.dependencies],
  );

  const graph = useMemo(() => TaskGraph.from(allTasks), [allTasks]);

  const blockedTaskIds = useMemo(() => {
    const myId = conversation.taskId;
    if (!myId) return new Set<string>();
    return new Set(graph.directDependents(myId).map((t) => t.id));
  }, [graph, conversation.taskId]);

  const convByTaskId = useMemo(() => {
    const map = new Map<string, (typeof active)[number]>();
    for (const c of active) {
      if (c.taskId === conversation.taskId) continue;
      if (!c.taskId) continue;
      if (!map.has(c.taskId)) map.set(c.taskId, c);
    }
    return map;
  }, [active, conversation.taskId]);

  // Blocked-by direction
  const blockerConvs = useMemo(
    () => [...convByTaskId.values()].filter((c) => depTaskIds.has(c.taskId!)),
    [convByTaskId, depTaskIds],
  );
  const orphanDepIds = useMemo(
    () => [...depTaskIds].filter((id) => !convByTaskId.has(id)),
    [depTaskIds, convByTaskId],
  );
  const blockedByCandidates = useMemo(
    () => [...convByTaskId.values()].filter((c) => !depTaskIds.has(c.taskId!)),
    [convByTaskId, depTaskIds],
  );

  // Blocking direction
  const blockedConvs = useMemo(
    () =>
      [...convByTaskId.values()].filter((c) => blockedTaskIds.has(c.taskId!)),
    [convByTaskId, blockedTaskIds],
  );
  const orphanBlockedIds = useMemo(
    () => [...blockedTaskIds].filter((id) => !convByTaskId.has(id)),
    [blockedTaskIds, convByTaskId],
  );
  const blockingCandidates = useMemo(
    () =>
      [...convByTaskId.values()].filter((c) => !blockedTaskIds.has(c.taskId!)),
    [convByTaskId, blockedTaskIds],
  );

  const addBlocker = useCallback(
    async (selectedConv: (typeof active)[number]) => {
      const depTaskId = selectedConv.taskId!;
      setBusy(depTaskId);
      try {
        await fetchEndpoint(
          addTaskDependency,
          { id: conversation.taskId },
          { body: { dependsOnTaskId: depTaskId } },
        );
      } catch (err) {
        toast({
          type: "conversation",
          title: "Failed to add dependency",
          description:
            err instanceof EndpointError
              ? typeof err.body === "string"
                ? err.body
                : `Server responded ${err.status}`
              : String(err),
          variant: "error",
        });
      } finally {
        setBusy(null);
      }
    },
    [conversation.taskId],
  );

  const removeBlocker = useCallback(
    async (depTaskId: string) => {
      setBusy(depTaskId);
      try {
        await fetchEndpoint(removeTaskDependency, {
          id: conversation.taskId,
          depId: depTaskId,
        });
      } finally {
        setBusy(null);
      }
    },
    [conversation.taskId],
  );

  const addBlocked = useCallback(
    async (selectedConv: (typeof active)[number]) => {
      const blockedTaskId = selectedConv.taskId!;
      setBusy(blockedTaskId);
      try {
        await fetchEndpoint(
          addTaskDependency,
          { id: blockedTaskId },
          { body: { dependsOnTaskId: conversation.taskId } },
        );
      } catch (err) {
        toast({
          type: "conversation",
          title: "Failed to add dependency",
          description:
            err instanceof EndpointError
              ? typeof err.body === "string"
                ? err.body
                : `Server responded ${err.status}`
              : String(err),
          variant: "error",
        });
      } finally {
        setBusy(null);
      }
    },
    [conversation.taskId],
  );

  const removeBlocked = useCallback(
    async (blockedTaskId: string) => {
      setBusy(blockedTaskId);
      try {
        await fetchEndpoint(removeTaskDependency, {
          id: blockedTaskId,
          depId: conversation.taskId,
        });
      } finally {
        setBusy(null);
      }
    },
    [conversation.taskId],
  );

  if (!conversation.taskId || !task) return null;

  const hasBlockedBy = depTaskIds.size > 0;
  const hasBlocking = blockedTaskIds.size > 0;
  const hasAny = hasBlockedBy || hasBlocking;

  const titleOf = (id: string) =>
    allTasks.find((at) => at.id === id)?.title ?? id;
  const peek: HoverCardContent = {
    title: "Dependencies",
    description: hasAny ? undefined : "Click to add dependencies",
    lists: [
      ...(hasBlockedBy
        ? [
            {
              label: "Blocked by",
              items: [
                ...blockerConvs.map((c) => ({
                  key: c.taskId,
                  text: c.title ?? titleOf(c.taskId),
                })),
                ...orphanDepIds.map((id) => ({
                  key: id,
                  text: titleOf(id),
                  muted: true,
                })),
              ],
            },
          ]
        : []),
      ...(hasBlocking
        ? [
            {
              label: "Blocking",
              items: [
                ...blockedConvs.map((c) => ({
                  key: c.taskId,
                  text: c.title ?? titleOf(c.taskId),
                })),
                ...orphanBlockedIds.map((id) => ({
                  key: id,
                  text: titleOf(id),
                  muted: true,
                })),
              ],
            },
          ]
        : []),
    ],
  };

  return (
    <WithHoverCard card={peek}>
      <ButtonGroup>
        <InlinePopover
          resetOnClose
          open={blockedByOpen}
          onOpenChange={setBlockedByOpen}
          align="end"
          width="2xl"
          padding="sm"
          trigger={
            <Button variant="ghost" aria-label="Blocked by">
              {hasBlockedBy && (
                <span className="text-3xs tabular-nums">{depTaskIds.size}</span>
              )}
              <span
                className={cn(
                  "text-3xs",
                  hasBlockedBy
                    ? "text-muted-foreground"
                    : "text-muted-foreground/40",
                )}
              >
                {"←"}
              </span>
            </Button>
          }
        >
          <DepPopoverContent
            label="Blocked by"
            currentConvs={blockerConvs}
            orphanIds={orphanDepIds}
            allTasks={allTasks}
            candidates={blockedByCandidates}
            busy={busy}
            onAdd={(c) => void addBlocker(c)}
            onRemove={(id) => void removeBlocker(id)}
          />
        </InlinePopover>

        <Center axis="vertical" className="px-xs">
          <Icon icon={linkIcon} className="size-3 text-muted-foreground" />
        </Center>

        <InlinePopover
          resetOnClose
          open={blockingOpen}
          onOpenChange={setBlockingOpen}
          align="end"
          width="2xl"
          padding="sm"
          trigger={
            <Button variant="ghost" aria-label="Blocking">
              <span
                className={cn(
                  "text-3xs",
                  hasBlocking
                    ? "text-muted-foreground"
                    : "text-muted-foreground/40",
                )}
              >
                {"→"}
              </span>
              {hasBlocking && (
                <span className="text-3xs tabular-nums">
                  {blockedTaskIds.size}
                </span>
              )}
            </Button>
          }
        >
          <DepPopoverContent
            label="Blocking"
            currentConvs={blockedConvs}
            orphanIds={orphanBlockedIds}
            allTasks={allTasks}
            candidates={blockingCandidates}
            busy={busy}
            onAdd={(c) => void addBlocked(c)}
            onRemove={(id) => void removeBlocked(id)}
          />
        </InlinePopover>
      </ButtonGroup>
    </WithHoverCard>
  );
}
