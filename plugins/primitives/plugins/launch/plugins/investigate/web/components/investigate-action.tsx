import { useState, type ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { appLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { taskDetailRoute } from "@plugins/tasks/plugins/tasks-core/core";
import type { TaskSubject } from "@plugins/tasks/plugins/task-subject/core";
import { useSubjectTask } from "@plugins/tasks/plugins/task-subject/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const investigateIcon = symbol("bug-report");

/** Where the action sits: an icon in a row's action cluster, or a labelled button in a pane. */
export type InvestigatePresentation = "row-action" | "button";

interface InvestigateCommon {
  /** What failed, in the copy: "this failed {noun}" ("build", "backup.run job"). */
  noun: string;
  presentation: InvestigatePresentation;
  /** What the agent will be told, in a line or two — the popover's description. */
  description: ReactNode;
  placeholder?: string;
}

/**
 * The generic form: the task is ABOUT a record (`subject`), filed under
 * `categoryId` and briefed with `brief(userText)`. The subject's live task is
 * read back live (`tasks/task-subject`), so once launched the action is "View
 * task" — and a second launch, from anywhere, reuses that task.
 */
export interface InvestigateSubjectProps extends InvestigateCommon {
  subject: TaskSubject;
  categoryId: string;
  brief: (userText: string) => string;
}

/**
 * For a domain that already owns its record → task link (reports'
 * `task_id`): the link it holds, and `resolve`, which files or reuses the task
 * and returns it with the prompt.
 */
export interface InvestigateLinkProps extends InvestigateCommon {
  linkedTaskId: string | null;
  /** Names what the launch is about, so an unsent draft survives (see `LaunchAgentForm`). */
  draftKey: string;
  resolve: (userText: string) => Promise<{ taskId: string; prompt: string }>;
}

export type InvestigateActionProps =
  InvestigateSubjectProps | InvestigateLinkProps;

/**
 * THE "launch an agent to investigate this failure" affordance: one icon, one
 * label, one popover, and — once a task exists for the failure — "View task"
 * instead of a second launch. Render it only on a failed record; the gate is
 * the caller's (or `Investigate.Register`'s `failed`).
 */
export function InvestigateAction(props: InvestigateActionProps) {
  return "subject" in props ? (
    <SubjectInvestigate {...props} />
  ) : (
    <LinkedInvestigate {...props} />
  );
}

function SubjectInvestigate(props: InvestigateSubjectProps) {
  const { subject, categoryId, brief } = props;
  const read = useSubjectTask(subject);
  // Not known yet is not "no task": the trigger waits for the answer rather
  // than offering a launch that might duplicate the task it is about to show.
  if (read.status === "loading") return <Pending {...props} />;
  if (read.status === "error") {
    return (
      <ResourceErrorInline
        error={read.error}
        refetch={read.refetch}
        variant={props.presentation === "row-action" ? "icon" : "inline"}
        subject="the investigation task"
      />
    );
  }
  if (read.data.taskId !== null) {
    return <ViewTask taskId={read.data.taskId} {...props} />;
  }
  return (
    <Launch
      {...props}
      draftKey={`investigate:${subject.kind}:${subject.id}`}
      getRequest={(userText) => ({
        prompt: brief(userText),
        categoryId,
        subject,
      })}
    />
  );
}

function LinkedInvestigate(props: InvestigateLinkProps) {
  // The task `resolve` linked, held until the domain's live record carries it
  // (its write routes after the launch resolves): without it a click in
  // between would launch a second agent. The record wins once it agrees.
  const [justLinked, setJustLinked] = useState<string | null>(null);
  const linked = props.linkedTaskId ?? justLinked;
  if (linked !== null) return <ViewTask taskId={linked} {...props} />;
  return (
    <Launch
      {...props}
      getRequest={async (userText) => {
        const { taskId, prompt } = await props.resolve(userText);
        setJustLinked(taskId);
        return { taskId, prompt };
      }}
    />
  );
}

function Launch({
  noun,
  presentation,
  description,
  placeholder = "Optional — what you already suspect, or what to check first…",
  draftKey,
  getRequest,
}: InvestigateCommon & {
  draftKey: string;
  getRequest: Parameters<typeof LaunchAgentPopover>[0]["getRequest"];
}) {
  return (
    <LaunchAgentPopover
      draftKey={draftKey}
      align={presentation === "row-action" ? "end" : "start"}
      title={`Investigate this failed ${noun}`}
      description={description}
      placeholder={placeholder}
      trigger={trigger(noun, presentation)}
      getRequest={getRequest}
    />
  );
}

const LABEL = "Investigate";

/**
 * The trigger ELEMENT (not a component of our own): the popover clones it as
 * its anchor, handing it the ref and click handlers, which only the
 * underlying button forwards.
 */
function trigger(
  noun: string,
  presentation: InvestigatePresentation,
  disabled = false,
) {
  if (presentation === "row-action") {
    return (
      <IconButton
        icon={investigateIcon}
        label={LABEL}
        tooltip={`Launch an agent to investigate this failed ${noun}`}
        disabled={disabled}
      />
    );
  }
  return (
    <Button variant="outline" className="gap-xs" disabled={disabled}>
      <Icon icon={investigateIcon} className="size-4" />
      {LABEL}
    </Button>
  );
}

function Pending({ noun, presentation }: InvestigateCommon) {
  return trigger(noun, presentation, true);
}

function ViewTask({
  taskId,
  noun,
  presentation,
}: InvestigateCommon & { taskId: string }) {
  const link = appLinkProps(taskDetailRoute.link(agentManagerApp, { taskId }));
  if (presentation === "row-action") {
    return (
      <IconButton
        {...link}
        icon={navIcons.expand}
        label="View task"
        tooltip={`Open the task investigating this failed ${noun}`}
      />
    );
  }
  return (
    <Button {...link} variant="outline" className="gap-xs">
      <Icon icon={navIcons.expand} className="size-4" />
      View task
    </Button>
  );
}
