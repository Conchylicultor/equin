import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  PaneChrome,
  PaneInstanceContext,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import {
  CONV_STATUS_DOT,
  conversationTitle,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import {
  attemptRows,
  type AttemptWithConversations,
} from "@plugins/tasks/plugins/tasks-core/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { attemptPane } from "../panes";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

function SideBySideButton({ convId }: { convId: string }) {
  const openPane = useOpenPane();
  return (
    <button
      type="button"
      title="Open alongside"
      {...activationProps(
        openPane.to(conversationPane, { convId }, { mode: "push" }),
        { isolate: true },
      )}
      className="rounded-md p-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon icon={navIcons.sidePane} className="size-3.5" />
    </button>
  );
}

function AttemptSection({
  attempt,
  isCurrent,
  selectedConvId,
  convInstanceId,
  convTarget,
}: {
  attempt: AttemptWithConversations;
  isCurrent: boolean;
  selectedConvId: string | undefined;
  convInstanceId: number | undefined;
  /** The link a conversation row opens. */
  convTarget: (convId: string) => LinkTarget;
}) {
  const worktreeName = attempt.worktreePath.split("/").pop();
  return (
    <Stack gap="2xs">
      <Line className="gap-xs px-sm py-xs">
        <Fill
          as="span"
          className={cn(
            "truncate font-mono text-2xs",
            isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {worktreeName}
        </Fill>
        <Badge className={rigidClass()}>{attempt.conversations.length}</Badge>
      </Line>
      {attempt.conversations.length === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground px-sm py-2xs italic"
        >
          No conversations
        </Text>
      ) : (
        <Stack as="ul" gap="2xs">
          {attempt.conversations.map((c) => {
            const isActive = c.id === selectedConvId;
            return (
              <Line
                as="li"
                key={c.id}
                className={cn(
                  "group rounded-md",
                  isActive ? "bg-accent" : "hover:bg-accent",
                )}
              >
                <Line
                  as="button"
                  type="button"
                  {...activationProps(convTarget(c.id))}
                  className={cn(
                    fillClasses("x"),
                    "gap-sm px-sm py-xs text-left text-body",
                  )}
                >
                  <StatusDot {...CONV_STATUS_DOT[c.status]} />
                  <Fill as="span" className="truncate">
                    {conversationTitle(c)}
                  </Fill>
                </Line>
                {convInstanceId !== undefined && !isActive && (
                  <Line
                    className={cn(
                      "pr-xs opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
                      rigidClass(),
                    )}
                  >
                    <PaneInstanceContext.Provider value={convInstanceId}>
                      <SideBySideButton convId={c.id} />
                    </PaneInstanceContext.Provider>
                  </Line>
                )}
              </Line>
            );
          })}
        </Stack>
      )}
      <LaunchControl
        variant="outline"
        className="px-sm pt-xs"
        getRequest={() => ({ attemptId: attempt.id })}
      />
    </Stack>
  );
}

/** Every attempt of the task the given attempt belongs to. */
function taskAttemptsOf(
  attempts: AttemptWithConversations[],
  attemptId: string,
): AttemptWithConversations[] {
  const attempt = attempts.find((a) => a.id === attemptId);
  return attempt ? attempts.filter((a) => a.taskId === attempt.taskId) : [];
}

/**
 * The pane's header title: "Attempts" plus a badge counting the conversations
 * across the task's attempts (none while the list loads, or when it is zero).
 */
export function AttemptsTitle() {
  const { attemptId } = attemptPane.useParams();
  const result = useLive(attemptRows);
  switch (result.status) {
    case "loading":
    case "error":
      return "Attempts";
    case "ready":
      break;
  }
  const totalConversations = taskAttemptsOf(result.data, attemptId).reduce(
    (sum, a) => sum + a.conversations.length,
    0,
  );
  return (
    <Inline gap="xs">
      Attempts
      {totalConversations > 0 && <Badge>{totalConversations}</Badge>}
    </Inline>
  );
}

export function AttemptPane() {
  const { attemptId } = attemptPane.useParams();
  const result = useLive(attemptRows);
  const openPane = useOpenPane();
  // ONE read of "the conversation column this pane opened". It used to be two —
  // the first conversation pane in the chain for the highlight, the last one for
  // the instance the side-by-side button pushes from — so with two conversation
  // columns open the pane lit up one row and opened alongside the other.
  const openedConv = conversationPane.useOpenedHere();
  const selectedConvId = openedConv?.params.convId;
  const convInstanceId = openedConv?.instanceId;

  if (result.status === "loading") return <Loading />;
  if (result.status === "error") {
    return (
      <PaneChrome pane={attemptPane}>
        <ResourceErrorInline
          variant="block"
          subject="the attempts"
          error={result.error}
          refetch={result.refetch}
        />
      </PaneChrome>
    );
  }

  const taskAttempts = taskAttemptsOf(result.data, attemptId);

  const convTarget = (convId: string) =>
    openPane.to(conversationPane, { convId }, { mode: "push" });

  return (
    <PaneChrome pane={attemptPane}>
      <Inset pad="sm">
        {taskAttempts.length === 0 ? (
          <Text
            as="p"
            variant="body"
            className="text-muted-foreground px-sm py-xs"
          >
            No attempts.
          </Text>
        ) : (
          <Stack gap="sm">
            {taskAttempts.map((a) => (
              <AttemptSection
                key={a.id}
                attempt={a}
                isCurrent={a.id === attemptId}
                selectedConvId={selectedConvId}
                convInstanceId={convInstanceId}
                convTarget={convTarget}
              />
            ))}
          </Stack>
        )}
      </Inset>
    </PaneChrome>
  );
}
