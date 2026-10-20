import { useState } from "react";

import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  useTaskAggregate,
  type TaskAggregate,
  type TaskEntry,
} from "./use-task-aggregate";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const radioButtonUncheckedIcon = symbol("radio-button-unchecked");
const timelapseIcon = symbol("timelapse");
const checkCircleIcon = symbol("check-circle");
const cancelIcon = symbol("cancel");
const stopCircleIcon = symbol("stop-circle");
const keyboardArrowDownIcon = symbol("keyboard-arrow-down");
const keyboardArrowUpIcon = symbol("keyboard-arrow-up");
const closeIcon = symbol("close");

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "in_progress":
      return (
        <Icon
          icon={timelapseIcon}
          className={cn("size-4 text-info", rigidClass())}
        />
      );
    case "completed":
      return (
        <Icon
          icon={checkCircleIcon}
          className={cn("size-4 text-success", rigidClass())}
        />
      );
    case "failed":
      return (
        <Icon
          icon={cancelIcon}
          className={cn("size-4 text-destructive", rigidClass())}
        />
      );
    case "stopped":
      return (
        <Icon
          icon={stopCircleIcon}
          className={cn("size-4 text-muted-foreground", rigidClass())}
        />
      );
    default:
      return (
        <Icon
          icon={radioButtonUncheckedIcon}
          className={cn("size-4 text-muted-foreground", rigidClass())}
        />
      );
  }
}

function TaskRow({ task }: { task: TaskEntry }) {
  return (
    <Text as="div" variant="caption">
      <Stack direction="row" gap="sm" align="center" className="px-md py-xs">
        <StatusIcon status={task.status} />
        <Fill as="span" className="truncate text-foreground/80">
          {task.description}
        </Fill>
        <span
          className={cn(
            "font-mono text-3xs text-muted-foreground/60",
            rigidClass(),
          )}
        >
          {task.taskId.slice(0, 8)}
        </span>
      </Stack>
    </Text>
  );
}

export function TaskProgressOverlay() {
  const aggregate = useTaskAggregate();
  // An overlay: nothing until the task list has landed (or if it cannot be read).
  return matchResource(aggregate, {
    loading: () => null,
    error: () => null,
    ready: (data) => <TaskProgress aggregate={data} />,
  });
}

function TaskProgress({ aggregate }: { aggregate: TaskAggregate }) {
  const { tasks, completedCount, totalCount, shouldShow } = aggregate;
  const [dismissed, setDismissed] = useState(false);
  const {
    open: expanded,
    triggerProps,
    contentProps,
  } = useCollapsible({ defaultOpen: true });

  if (!shouldShow || dismissed) return null;

  return (
    <Pin
      to="bottom"
      stretch
      decorative
      layer="float"
      // bottom-10 (2.5rem) is off the spacing ramp, so override Pin's flush inset.
      style={{ bottom: "2.5rem" }}
    >
      <Center axis="horizontal">
        {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mx-4 gutters the centered card; can't fold into the parent without breaking the centered max-width */}
        <div className="pointer-events-auto mx-4 w-full max-w-sm rounded-lg border bg-background/90 shadow-sm backdrop-blur-sm">
          <Stack
            direction="row"
            gap="none"
            align="center"
            className="px-md py-sm"
          >
            <Text
              as="span"
              variant="caption"
              className="tabular-nums text-muted-foreground"
            >
              {completedCount}/{totalCount} complete
            </Text>
            <Fill />
            <Stack direction="row" gap="xs" align="center">
              <button
                {...triggerProps}
                aria-label={expanded ? "Collapse tasks" : "Expand tasks"}
                className="rounded-md p-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {expanded ? (
                  <Icon icon={keyboardArrowDownIcon} className="size-4" />
                ) : (
                  <Icon icon={keyboardArrowUpIcon} className="size-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="rounded-md p-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Icon icon={closeIcon} className="size-4" />
              </button>
            </Stack>
          </Stack>
          {tasks.length > 0 && (
            <FoldMotion {...contentProps}>
              <Scroll className="max-h-[180px] border-t border-border/40 py-xs">
                {tasks.map((task) => (
                  <TaskRow key={task.taskId} task={task} />
                ))}
              </Scroll>
            </FoldMotion>
          )}
        </div>
      </Center>
    </Pin>
  );
}
