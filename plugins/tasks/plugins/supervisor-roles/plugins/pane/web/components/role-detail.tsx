import { useState, type ReactElement, type ReactNode } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useConfig } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconPicker } from "@plugins/primitives/plugins/icon-picker/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { symbol, type SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";
import {
  supervisorPromptConfig,
  updateSupervisorRole,
  type SupervisorRole,
  type UpdateSupervisorRoleBody,
} from "@plugins/tasks/plugins/supervisor-roles/core";
import { useRoleBacklog, useRoleSessions, useRoles } from "../internal/reads";
import { InlineMarkdownField, InlineTextField } from "./inline-fields";
import { RoleIcon } from "./role-icon";
import { SessionBand } from "./session-band";
import { BacklogSection } from "./backlog-section";
import { SessionsSection } from "./sessions-section";

const autoIcon = symbol("auto-awesome");
const NO_TASKS: readonly TaskTreeRow[] = [];
const sharedIcon = symbol("stacks");
const chevronIcon = symbol("chevron-right");

/** One role, read from the (whole, live) roles set. */
export function RoleDetail({
  roleId,
  linkToShared,
}: {
  roleId: string;
  linkToShared: () => LinkTarget;
}): ReactElement {
  const roles = useRoles();
  return foldResource(roles, {
    loading: () => <Loading variant="rows" />,
    error: (err) => <Placeholder tone="error">{err.message}</Placeholder>,
    ready: (rs) => {
      const role = rs.find((r) => r.id === roleId);
      return role ? (
        <RoleDetailBody
          key={role.id}
          role={role}
          justCreated={isUnsetUp(role)}
          linkToShared={linkToShared}
        />
      ) : (
        <Placeholder>This supervisor no longer exists.</Placeholder>
      );
    },
  });
}

/**
 * A role not set up yet — still its "New supervisor" name and no prompt: it
 * opens with its name focused and its prompt in the editor.
 */
function isUnsetUp(role: SupervisorRole): boolean {
  return /^New supervisor( \d+)?$/.test(role.name) && role.prompt === "";
}

function useSaveRole(roleId: string) {
  const fetchEndpoint = useFetchEndpoint();
  return (body: UpdateSupervisorRoleBody) =>
    fetchEndpoint(updateSupervisorRole, { id: roleId }, { body });
}

function RoleDetailBody({
  role,
  justCreated,
  linkToShared,
}: {
  role: SupervisorRole;
  justCreated: boolean;
  linkToShared: () => LinkTarget;
}): ReactElement {
  const save = useSaveRole(role.id);
  const backlog = useRoleBacklog(role.id);
  const sessions = useRoleSessions(role.id);
  const sessionRows = sessions.status === "ready" ? sessions.data : NO_TASKS;
  const backlogRows = backlog.status === "ready" ? backlog.data : NO_TASKS;
  const oldest = backlogRows[0];
  return (
    <Stack gap="xl" className="rail-lg">
      <Stack direction="row" gap="md" align="center">
        <IconPick role={role} onPick={(icon) => save({ icon })} />
        <Fill>
          <InlineTextField
            variant="title"
            label="Name"
            placeholder="Name"
            value={role.name}
            autoFocus={justCreated}
            onSave={(v) => (v.trim() === "" ? undefined : save({ name: v }))}
          />
        </Fill>
      </Stack>

      {sessions.status === "loading" || backlog.status === "loading" ? (
        <Loading variant="block" className="h-16 w-full" />
      ) : (
        <SessionBand
          role={role}
          sessions={sessionRows}
          backlog={backlogRows.length}
          oldest={oldest ? new Date(oldest.createdAt) : null}
        />
      )}

      <Card padding="none">
        <SettingRow label="Listed to agents">
          <Stack direction="row" gap="sm" align="center">
            <Switch
              checked={role.listed}
              onCheckedChange={(listed) => save({ listed })}
              aria-label="Listed to agents"
            />
            <Text variant="caption" tone="muted">
              {role.listed
                ? "In every agent's supervisor list"
                : "Only reachable by re-routing"}
            </Text>
          </Stack>
        </SettingRow>
        <SettingRow label="Description agents get" dim={!role.listed}>
          <InlineTextField
            label="Description agents get"
            placeholder="What belongs here, in one line"
            value={role.description}
            disabled={!role.listed}
            onSave={(description) => save({ description })}
          />
        </SettingRow>
        <SettingRow label="Supervisor prompt" top>
          <Stack gap="md">
            <InlineMarkdownField
              label="Supervisor prompt"
              namespace="supervisor-role-prompt"
              placeholder="What a session of this supervisor is launched with"
              value={role.prompt}
              startEditing={justCreated}
              onSave={(prompt) => save({ prompt })}
            />
            <SharedPromptPeek linkToShared={linkToShared} />
          </Stack>
        </SettingRow>
      </Card>

      <BacklogSection role={role} backlog={backlog} />
      <SessionsSection roleId={role.id} sessions={sessionRows} />
    </Stack>
  );
}

/** One inline setting: its label in a fixed column, the value beside it. */
function SettingRow({
  label,
  children,
  dim,
  top,
}: {
  label: string;
  children: ReactNode;
  /** The setting does not apply right now (shown, faded). */
  dim?: boolean;
  /** Label aligned to the value's first line (a multi-line value). */
  top?: boolean;
}): ReactElement {
  return (
    <Stack
      direction="row"
      gap="lg"
      align={top ? "start" : "center"}
      className={cn("border-b p-md last:border-b-0", dim && "opacity-50")}
    >
      <Text variant="caption" tone="muted" className={`w-44 ${rigidClass()}`}>
        {label}
      </Text>
      <Fill>{children}</Fill>
    </Stack>
  );
}

/**
 * The shared prompt, folded under the role's own: it is sent first to every
 * session, so it reads here; it is edited in All supervisors.
 */
function SharedPromptPeek({
  linkToShared,
}: {
  linkToShared: () => LinkTarget;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const shared = useConfig(supervisorPromptConfig).prompt;
  const lines = shared.split("\n").filter((l) => l.trim() !== "").length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="rounded-md text-caption text-muted-foreground hover:text-foreground">
        <Inline gap="xs">
          <Icon
            icon={chevronIcon}
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
          <Icon icon={sharedIcon} className="size-3.5" />
          Shared prompt
          <Text as="span" variant="caption" tone="faint">
            {lines === 0 ? "empty" : `sent first · ${lines} lines`}
          </Text>
        </Inline>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="sm" className="pl-lg">
          {shared.trim() === "" ? (
            <Text variant="caption" tone="muted">
              No shared prompt.
            </Text>
          ) : (
            <Text as="div" variant="body" tone="muted">
              <Markdown>{shared}</Markdown>
            </Text>
          )}
          <Button variant="link" {...linkProps(linkToShared())}>
            Edit in All supervisors
          </Button>
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The role's icon, big: picked automatically (Haiku, from the name and
 * description) unless a person picks one here; Automatic hands it back.
 */
function IconPick({
  role,
  onPick,
}: {
  role: SupervisorRole;
  onPick: (icon: SavedSymbolName | null) => Promise<unknown>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const pick = (icon: SavedSymbolName | null) => {
    setOpen(false);
    return onPick(icon);
  };
  return (
    <ControlSizeProvider size="lg">
      <ControlPanelPopover
        open={open}
        onOpenChange={setOpen}
        label={`Icon of ${role.name}`}
        side="bottom"
        align="start"
        trigger={
          <Button
            variant="outline"
            aria-label={
              role.iconByUser ? "Icon" : "Icon — picked automatically"
            }
            className="relative"
          >
            <RoleIcon role={role} className="size-5" />
            {role.iconByUser ? null : (
              <Pin to="bottom-right" offset="2xs" outset decorative>
                <Icon icon={autoIcon} className="size-3 text-primary-text" />
              </Pin>
            )}
          </Button>
        }
      >
        <ControlPanel.Section>
          <ControlPanel.Row
            icon={<Icon icon={autoIcon} />}
            selected={!role.iconByUser}
            onSelect={() => pick(null)}
            hint="Picked from the name and description, again when they change"
          >
            Automatic
          </ControlPanel.Row>
        </ControlPanel.Section>
        <ControlPanel.Section needs="picker">
          {open ? (
            <IconPicker
              value={role.iconByUser ? role.icon : null}
              onSelect={(name) => void pick(name)}
            />
          ) : null}
        </ControlPanel.Section>
      </ControlPanelPopover>
    </ControlSizeProvider>
  );
}
