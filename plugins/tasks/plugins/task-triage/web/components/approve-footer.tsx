import type { ReactElement } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { LaunchDecision } from "@plugins/tasks/plugins/automations/core";
import {
  setTaskApproval,
  useTaskApproval,
} from "@plugins/tasks/plugins/automations/web";

const checkIcon = symbol("check");

/** What the footer's hint says, by the task's launch decision. */
const HINT: Record<LaunchDecision | "none", string> = {
  approved: "Approved — a launch automation may start it.",
  excluded: "Excluded from launch. Approving overrides that.",
  none: "Approval doesn't require a triage.",
};

/**
 * The decision, beside the read and independent of it: **Approve** /
 * **✓ Approved**, a toggle on the task's launch decision. Taking an approval
 * back never erases an exclusion. While the decision is not known yet the
 * button pends — never an "Approve" that turns out to be approved already.
 */
export function ApproveFooter({ taskId }: { taskId: string }): ReactElement {
  const approval = useTaskApproval(taskId);
  if (approval.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the approval"
        error={approval.error}
        refetch={approval.refetch}
      />
    );
  }
  const decision = approval.status === "ready" ? approval.data : undefined;
  const approved = decision === "approved";
  return (
    <Stack direction="row" gap="sm" align="center" className="border-t pt-md">
      <Fill>
        <Text variant="caption" tone="muted">
          {decision === undefined ? "" : HINT[decision ?? "none"]}
        </Text>
      </Fill>
      <Button
        variant={approved ? "outline" : "default"}
        loading={decision === undefined}
        aria-pressed={approved}
        onClick={() => setTaskApproval(taskId, !approved)}
        className={rigidClass()}
      >
        {approved ? <Icon icon={checkIcon} /> : null}
        {approved ? "Approved" : "Approve"}
      </Button>
    </Stack>
  );
}
