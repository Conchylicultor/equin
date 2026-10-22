import { useLive } from "@plugins/network/plugins/live/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, useMemo, useCallback, type ReactElement } from "react";
import {
  useActiveConversations,
  useConversationById,
} from "@plugins/conversations/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { addTaskDependency, removeTaskDependency } from "@plugins/tasks/core";
import {
  isSettled,
  taskRows,
  TaskGraph,
  type Conversation as ConversationRecord,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  EndpointError,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { hoverRevealTargetInAnchor } from "@plugins/primitives/plugins/hover-reveal/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { DepSection } from "./dep-section";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const linkIcon = symbol("add-link");
const upIcon = symbol("arrow-upward");
const downIcon = symbol("arrow-downward");
const resolvedIcon = symbol("swap-vert");

/**
 * The task's links, in the conversation header. The face counts only what is
 * still open — ↑ n blockers it waits on (upstream), ↓ n tasks waiting on it
 * (downstream); with links but none open it is a faint ↕, and with no links a
 * link icon that shows on header hover. One popover lists every link of both
 * directions, resolved ones included, and adds or removes them.
 */
export function DependenciesButton(): ReactElement | null {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const tasksResult = useLive(taskRows);
  const activeResult = useActiveConversations();
  const combined = useCombinedResources({
    tasks: tasksResult,
    active: activeResult,
  });
  if (!conversation?.taskId) return null;
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
      taskId={conversation.taskId}
      allTasks={combined.data.tasks}
      active={combined.data.active}
    />
  );
}

function DependenciesButtonInner({
  taskId,
  allTasks,
  active,
}: {
  taskId: string;
  allTasks: TaskListItem[];
  active: ConversationRecord[];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();

  const graph = useMemo(() => TaskGraph.from(allTasks), [allTasks]);
  const byId = useMemo(
    () => new Map(allTasks.map((t) => [t.id, t])),
    [allTasks],
  );
  const linkedTasks = useCallback(
    (ids: string[]) =>
      ids.flatMap((id) => {
        const t = byId.get(id);
        return t ? [t] : [];
      }),
    [byId],
  );
  // Both directions, every edge — resolved ones included (the popover lists
  // them); only the face's counts leave the settled ones out.
  const after = useMemo(
    () => linkedTasks(graph.directDependencies(taskId).map((t) => t.id)),
    [graph, linkedTasks, taskId],
  );
  const blocks = useMemo(
    () => linkedTasks(graph.directDependents(taskId).map((t) => t.id)),
    [graph, linkedTasks, taskId],
  );

  // One running conversation per other task: the candidates a link can add.
  const convByTaskId = useMemo(() => {
    const map = new Map<string, ConversationRecord>();
    for (const c of active) {
      if (!c.taskId || c.taskId === taskId) continue;
      if (!map.has(c.taskId)) map.set(c.taskId, c);
    }
    return map;
  }, [active, taskId]);
  const candidatesExcept = useCallback(
    (linked: TaskListItem[]) => {
      const ids = new Set(linked.map((t) => t.id));
      return [...convByTaskId.values()].filter((c) => !ids.has(c.taskId!));
    },
    [convByTaskId],
  );

  const mutate = useCallback(
    async (key: string, run: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await run();
      } catch (err) {
        if (!(err instanceof EndpointError)) throw err;
        toast({
          type: "conversation",
          title: "Failed to update dependencies",
          description:
            typeof err.body === "string"
              ? err.body
              : `Server responded ${err.status}`,
          variant: "error",
        });
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  const up = after.filter((t) => !isSettled(t.status)).length;
  const down = blocks.filter((t) => !isSettled(t.status)).length;
  const total = after.length + blocks.length;
  const tip =
    total === 0
      ? "Link tasks"
      : up + down === 0
        ? `All ${total} linked tasks resolved`
        : [up > 0 && `Waiting on ${up}`, down > 0 && `${down} waiting on this`]
            .filter(Boolean)
            .join(" · ");

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label="Task links"
      trigger={
        <Button
          variant="ghost"
          aria-label={tip}
          tooltip={tip}
          tooltipSide="bottom"
          className={cn(
            "gap-sm text-muted-foreground tabular-nums",
            up + down === 0 && !open && hoverRevealTargetInAnchor,
          )}
        >
          {total === 0 ? (
            <Icon icon={linkIcon} className="size-4" />
          ) : up + down === 0 ? (
            <Icon icon={resolvedIcon} className="size-4 opacity-60" />
          ) : (
            <>
              {up > 0 && (
                <Stack as="span" direction="row" gap="2xs" align="center">
                  <Icon icon={upIcon} className="size-3.5" />
                  {up}
                </Stack>
                )}
              {down > 0 && (
                <Stack as="span" direction="row" gap="2xs" align="center">
                  <Icon icon={downIcon} className="size-3.5" />
                  {down}
                </Stack>
              )}
            </>
          )}
        </Button>
      }
    >
      {/* One band per direction; the panel rules the line between them. */}
      <ControlPanel.Section>
        <DepSection
          label="Runs after"
          hint="starts once these are done"
          linked={after}
          candidates={candidatesExcept(after)}
          busy={busy}
          onAdd={(c) =>
            void mutate(c.taskId!, () =>
              fetchEndpoint(
                addTaskDependency,
                { id: taskId },
                { body: { dependsOnTaskId: c.taskId! } },
              ),
            )
          }
          onRemove={(id) =>
            void mutate(id, () =>
              fetchEndpoint(removeTaskDependency, {
                id: taskId,
                depId: id,
              }),
            )
          }
        />
      </ControlPanel.Section>
      <ControlPanel.Section>
        <DepSection
          label="Blocks"
          hint="wait for this one"
          linked={blocks}
          candidates={candidatesExcept(blocks)}
            busy={busy}
          onAdd={(c) =>
            void mutate(c.taskId!, () =>
              fetchEndpoint(
                addTaskDependency,
                { id: c.taskId! },
                { body: { dependsOnTaskId: taskId } },
              ),
            )
          }
          onRemove={(id) =>
            void mutate(id, () =>
              fetchEndpoint(removeTaskDependency, { id, depId: taskId }),
            )
          }
          />
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}
