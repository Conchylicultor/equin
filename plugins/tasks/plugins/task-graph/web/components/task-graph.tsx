import { Icon } from "@plugins/ui/plugins/icons/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useMemo, useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  GraphCanvas,
  type GraphCanvasNode,
  type GraphCanvasEdge,
  type GraphCanvasGroup,
} from "@plugins/primitives/plugins/graph-canvas/web";
import { addTaskDependency } from "@plugins/tasks/core";
import {
  isSettled,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { patchTask } from "@plugins/tasks/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { STATUS_META } from "@plugins/tasks/plugins/task-status/web";
import { EdgeActions } from "./edge-actions";
import { useTaskClosure } from "../hooks";

function getGroupDepth(
  groupId: string,
  byId: Map<string, TaskListItem>,
): number {
  let depth = 0;
  let current = groupId;
  const seen = new Set<string>();
  while (true) {
    const anchor = byId.get(current);
    if (!anchor?.groupId || seen.has(anchor.groupId)) break;
    seen.add(current);
    current = anchor.groupId;
    depth++;
  }
  return depth;
}

const GROUP_PALETTE = [
  {
    bg: cn("bg-categorical-1/8 border-categorical-1/30"),
    text: cn("text-categorical-1/70"),
  },
  {
    bg: cn("bg-categorical-2/8 border-categorical-2/30"),
    text: cn("text-categorical-2/70"),
  },
  {
    bg: cn("bg-categorical-3/8 border-categorical-3/30"),
    text: cn("text-categorical-3/70"),
  },
  {
    bg: cn("bg-categorical-4/8 border-categorical-4/30"),
    text: cn("text-categorical-4/70"),
  },
];

/** Hover-revealed soft-drop button rendered as a node `actions` overlay. */
function DeleteTaskButton({ taskId }: { taskId: string }) {
  const [deleting, setDeleting] = useState(false);
  const fetchEndpoint = useFetchEndpoint();
  // "Delete" is a soft drop — marks the task dropped (reversible), never removing
  // the row. Tasks are never hard-deleted.
  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (deleting) return;
      setDeleting(true);
      void patchTask(fetchEndpoint, taskId, { drop: true }).finally(() =>
        setDeleting(false),
      );
    },
    [taskId, deleting, fetchEndpoint],
  );
  return (
    <button
      type="button"
      className="bg-background text-foreground hover:bg-destructive hover:text-destructive-foreground size-5 rounded-full border shadow-sm disabled:opacity-50"
      disabled={deleting}
      onClick={handleDelete}
      aria-label="Delete task"
    >
      <Center className="size-full">
        <span className="text-caption font-medium">&times;</span>
      </Center>
    </button>
  );
}

function buildGraph(
  closure: readonly TaskListItem[],
  allTasks: readonly TaskListItem[],
  selectedId: string,
  onNavigate: (taskId: string) => void,
): {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  groups: GraphCanvasGroup[];
} {
  const ids = new Set(closure.map((t) => t.id));
  const byId = new Map(closure.map((t) => [t.id, t]));
  const childIds = new Set(
    allTasks.filter((t) => t.folderId).map((t) => t.folderId!),
  );

  const nodes: GraphCanvasNode[] = closure.map((task) => {
    const meta = STATUS_META[task.status];
    const icon = meta.icon;
    const selected = task.id === selectedId;
    const isTerminal = isSettled(task.status);
    const hasChildren = childIds.has(task.id);
    return {
      id: task.id,
      label: task.title || "Untitled",
      title: `${task.title} — ${meta.label}`,
      tintClass: isTerminal ? "text-muted-foreground" : null,
      ringClass: selected ? "border-primary ring-primary/30 ring-2" : null,
      labelClassName:
        task.status === "dropped" ? cn("italic line-through") : null,
      leading: (
        <Icon
          icon={icon}
          className={cn("size-4", rigidClass(), meta.iconClassName)}
        />
      ),
      connectable: true,
      actions: hasChildren ? undefined : <DeleteTaskButton taskId={task.id} />,
    };
  });

  const edges: GraphCanvasEdge[] = [];
  for (const t of closure) {
    for (const dep of t.dependencies) {
      if (!ids.has(dep)) continue;
      const depTask = byId.get(dep)!;
      edges.push({
        from: dep,
        to: t.id,
        tone: isSettled(depTask.status) ? "success" : "muted",
        actions: (
          <EdgeActions
            sourceTaskId={dep}
            targetTaskId={t.id}
            targetFolderId={t.folderId ?? null}
            onNavigate={onNavigate}
          />
        ),
      });
    }
  }

  // Groups: one background per groupId present in the closure, enclosing its
  // members plus the anchor task itself.
  const groupMembers = new Map<string, string[]>();
  for (const t of closure) {
    if (t.groupId && ids.has(t.groupId)) {
      const list = groupMembers.get(t.groupId) ?? [];
      list.push(t.id);
      groupMembers.set(t.groupId, list);
    }
  }
  for (const [groupId, members] of groupMembers) {
    if (!members.includes(groupId)) members.push(groupId);
  }
  const groups: GraphCanvasGroup[] = [...groupMembers.entries()]
    .map(([groupId, memberIds]) => ({
      groupId,
      memberIds,
      depth: getGroupDepth(groupId, byId),
    }))
    // Shallower groups first so they render behind deeper (nested) ones.
    .sort((a, b) => a.depth - b.depth)
    .map(({ groupId, memberIds, depth }) => {
      const palette = GROUP_PALETTE[depth % GROUP_PALETTE.length]!;
      return {
        id: `group-${groupId}`,
        label: byId.get(groupId)?.title || "Group",
        memberIds,
        bgClassName: palette.bg,
        labelClassName: palette.text,
      };
    });

  return { nodes, edges, groups };
}

export function TaskGraph({ taskId }: { taskId: string }) {
  const closure = useTaskClosure(taskId);
  const fetchEndpoint = useFetchEndpoint();
  // Clicking a node re-roots this pane in place, keeping the URL truthful.
  const openPane = useOpenPane();
  const taskTarget = useCallback(
    (id: string) =>
      openPane.to(taskDetailPane, { taskId: id }, { mode: "swap" }),
    [openPane],
  );
  // A task the edge's "+" just created opens after the mutation settles: no
  // gesture to read, so the plain open.
  const onNavigate = useCallback(
    (id: string) => taskTarget(id).open(),
    [taskTarget],
  );
  const onConnect = useCallback(
    (source: string, target: string) => {
      void fetchEndpoint(
        addTaskDependency,
        { id: target },
        { body: { dependsOnTaskId: source } },
      );
    },
    [fetchEndpoint],
  );
  const graph = useMemo(
    () =>
      closure &&
      buildGraph(closure.closure, closure.allTasks, taskId, onNavigate),
    [closure, taskId, onNavigate],
  );

  // Only reachable while the task list is still loading: `useAvailable` keeps
  // the card unpainted until the closure is known to have more than one node.
  if (!graph) return <Loading />;
  const { nodes, edges, groups } = graph;

  return (
    // Fixed-height viewport for the canvas — the section card supplies the
    // surface, border and radius, so this carries only the height.
    <Clip className="h-60">
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        groups={groups}
        connectable
        onConnect={onConnect}
        nodeActivation={taskTarget}
        edgePath="smoothstep"
        minZoom={0.5}
      />
    </Clip>
  );
}
