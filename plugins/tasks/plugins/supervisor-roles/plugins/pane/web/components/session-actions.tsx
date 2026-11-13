import type { ReactElement } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  activationProps,
  linkProps,
} from "@plugins/primitives/plugins/link-gesture/web";
import { useConversationOpener } from "@plugins/conversations/plugins/conversation-view/web";
import { useTaskConversations } from "@plugins/tasks/plugins/tasks-core/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { launchRoleSession } from "@plugins/tasks/plugins/supervisor-roles/plugins/sessions/core";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const playIcon = symbol("play-arrow");
// A session opens as the page it is (its conversation, full surface).
const openIcon = navIcons.expand;

/**
 * Where a session opens: its latest conversation (the supervisor at work),
 * or the session's task while it has none yet (just launched, still
 * starting). `null` until the session's runs are known.
 */
function useSessionTarget(taskId: string): LinkTarget | null {
  const runs = useTaskConversations(taskId);
  const opener = useConversationOpener();
  const openPane = useOpenPane();
  if (runs.status !== "ready") return null;
  const latest = runs.data.at(-1);
  return latest
    ? opener.asPage(latest.id)
    : openPane.to(taskDetailPane, { taskId }, { mode: "push" });
}

/** Launch a role's session (its one live session: the server answers the
 * live one instead of launching a second). Returns the promise, so the
 * button pends while it is in flight. */
function useLaunchSession(roleId: string): () => Promise<unknown> {
  const fetchEndpoint = useFetchEndpoint();
  return () => fetchEndpoint(launchRoleSession, { id: roleId }, { body: {} });
}

/** The prominent Open session action (the live band). */
export function OpenSessionButton({
  taskId,
}: {
  taskId: string;
}): ReactElement {
  const target = useSessionTarget(taskId);
  return (
    <ControlSizeProvider size="lg">
      <Button
        disabled={target === null}
        {...(target === null ? {} : linkProps(target))}
      >
        <Icon icon={openIcon} />
        Open session
      </Button>
    </ControlSizeProvider>
  );
}

/** The prominent Launch session action (the idle band). */
export function LaunchSessionButton({
  roleId,
  disabled,
}: {
  roleId: string;
  disabled?: boolean;
}): ReactElement {
  const launch = useLaunchSession(roleId);
  return (
    <ControlSizeProvider size="lg">
      <Button disabled={disabled} onClick={launch}>
        <Icon icon={playIcon} />
        Launch session
      </Button>
    </ControlSizeProvider>
  );
}

/** A list row's compact Open session action. */
export function OpenSessionIconButton({
  taskId,
  label,
}: {
  taskId: string;
  label: string;
}): ReactElement {
  const target = useSessionTarget(taskId);
  return (
    <IconButton
      icon={openIcon}
      label={label}
      disabled={target === null}
      {...activationProps(target ?? undefined, { isolate: true })}
    />
  );
}

/** A list row's compact Launch session action. */
export function LaunchSessionIconButton({
  roleId,
}: {
  roleId: string;
}): ReactElement {
  const launch = useLaunchSession(roleId);
  return (
    <IconButton
      icon={playIcon}
      label="Launch session"
      variant="secondary"
      onClick={(e) => {
        e.stopPropagation();
        return launch();
      }}
    />
  );
}
