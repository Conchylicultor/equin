import { Icon } from "@plugins/ui/plugins/icons/web";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

import {
  TASK_STATUS_OPTIONS,
  type TaskStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

const cancelIcon = symbol("cancel");
const checkCircleIcon = symbol("check-circle");
const incompleteCircleIcon = symbol("incomplete-circle");
const inputIcon = symbol("input");
const pauseCircleIcon = symbol("pause-circle");
const radioButtonUncheckedIcon = symbol("radio-button-unchecked");
const timelapseIcon = symbol("timelapse");

/**
 * States that warrant a colored filled badge (they need the user's attention).
 * Everything else is a neutral at-rest signal rendered as a quiet StatusDot +
 * muted label. Single source of truth so call sites never re-derive this.
 */
const ATTENTION_STATUSES = new Set<TaskStatus>(["need_action", "held"]);

export const STATUS_META: Record<
  TaskStatus,
  {
    icon: IconRef;
    iconClassName: ClassName;
    label: string;
    badgeClassName: ClassName;
    /** Background color class for the at-rest StatusDot read-signal. */
    dotClass: string;
  }
> = {
  new: {
    icon: radioButtonUncheckedIcon,
    iconClassName: cn("text-muted-foreground/60"),
    label: TASK_STATUS_OPTIONS.new.label,
    badgeClassName: cn("bg-muted"),
    dotClass: "bg-muted-foreground/40",
  },
  in_progress: {
    icon: timelapseIcon,
    iconClassName: cn("text-info"),
    label: TASK_STATUS_OPTIONS.in_progress.label,
    badgeClassName: cn("bg-muted"),
    dotClass: "bg-info",
  },
  need_action: {
    icon: inputIcon,
    iconClassName: cn("text-warning"),
    label: TASK_STATUS_OPTIONS.need_action.label,
    badgeClassName: cn("bg-warning/15 text-warning"),
    dotClass: "bg-warning",
  },
  attempted: {
    icon: incompleteCircleIcon,
    iconClassName: cn("text-muted-foreground"),
    label: TASK_STATUS_OPTIONS.attempted.label,
    badgeClassName: cn("bg-muted"),
    dotClass: "bg-muted-foreground/60",
  },
  done: {
    icon: checkCircleIcon,
    iconClassName: cn("text-success"),
    label: TASK_STATUS_OPTIONS.done.label,
    badgeClassName: cn("bg-muted"),
    dotClass: "bg-success",
  },
  held: {
    icon: pauseCircleIcon,
    iconClassName: cn("text-warning"),
    label: TASK_STATUS_OPTIONS.held.label,
    badgeClassName: cn("bg-warning/15 text-warning"),
    dotClass: "bg-warning",
  },
  dropped: {
    icon: cancelIcon,
    iconClassName: cn("text-muted-foreground/50"),
    label: TASK_STATUS_OPTIONS.dropped.label,
    badgeClassName: cn("bg-muted text-muted-foreground/60 italic"),
    dotClass: "bg-muted-foreground/40",
  },
  blocked: {
    icon: pauseCircleIcon,
    iconClassName: cn("text-muted-foreground"),
    label: TASK_STATUS_OPTIONS.blocked.label,
    badgeClassName: cn("bg-muted text-muted-foreground"),
    dotClass: "bg-muted-foreground/60",
  },
  // Same blocked task, with an agent running on it. Carries the running colour
  // (info) so the live attempt is visible at a glance, and says so in the label
  // rather than reading as a plain `Blocked` row nothing is happening on.
  in_progress_blocked: {
    icon: timelapseIcon,
    iconClassName: cn("text-info"),
    label: TASK_STATUS_OPTIONS.in_progress_blocked.label,
    badgeClassName: cn("bg-muted"),
    dotClass: "bg-info",
  },
};

export function StatusIcon({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  const icon = meta.icon;
  return (
    <Center
      as="span"
      title={meta.label}
      aria-label={meta.label}
      className={cn("size-5", rigidClass())}
    >
      <Icon icon={icon} className={cn("size-4", meta.iconClassName)} />
    </Center>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  return <Badge colorClass={meta.badgeClassName}>{meta.label}</Badge>;
}

/**
 * Status as a read-signal with proper emphasis tiers: a colored filled badge
 * only for attention states (need_action / held); every neutral state recedes
 * to a quiet StatusDot + muted label. Color is reserved for what needs action.
 */
export function StatusSignal({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  if (ATTENTION_STATUSES.has(status)) {
    return <StatusBadge status={status} />;
  }
  return (
    <Inline gap="xs">
      <StatusDot colorClass={meta.dotClass} />
      <Text variant="caption" tone="muted">
        {meta.label}
      </Text>
    </Inline>
  );
}
