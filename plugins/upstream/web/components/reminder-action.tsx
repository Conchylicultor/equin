import { Fragment } from "react";
import { useSetConfig } from "@plugins/config_v2/web";
import type {
  NotificationActionControlProps,
  NotificationActionKind,
} from "@plugins/shell/plugins/notifications/web";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { upstreamReminderConfig } from "../../shared/reminder-config";
import {
  LATER_CHOICES,
  laterWrite,
  REMINDER_ACTION_KIND,
  ReminderPayloadSchema,
} from "../../shared/reminder";
import { useUpdatesView } from "../internal/use-updates";
import { SendAgentButton } from "./updates-row";

const chevronIcon = symbol("keyboard-arrow-down");

/**
 * The update reminder's controls: "Send agent to update" (the health row's
 * own launch popover) and "Remind me later ▾" — Tomorrow / In a week / In a
 * month / Skip this release / Never, each writing the reminder config
 * (`laterWrite`). Either settles the notification (`done`).
 *
 * Drawn only while the release it names is still the update to make: once an
 * agent is on it the health row follows it, and once it is in the row says so
 * (the job marks the notification resolved).
 */
function UpdateReminderControl({
  payload,
  done,
}: NotificationActionControlProps) {
  const { current, latest } = ReminderPayloadSchema.parse(payload);
  const view = useUpdatesView();
  const setConfig = useSetConfig(upstreamReminderConfig);
  if (view.kind === "pending")
    // Not known yet: the controls, disabled — never a guess either way.
    return (
      <Line className="gap-xs">
        <Button disabled>Send agent to update</Button>
        <Button variant="ghost" disabled>
          Remind me later
        </Button>
      </Line>
    );
  if (view.kind === "error")
    return (
      <Text variant="caption" tone="destructive">
        Could not read {view.what}
      </Text>
    );
  if (view.kind !== "out-of-date" || view.latest !== latest) return null;
  return (
    <Line className="gap-xs">
      <SendAgentButton
        current={current}
        latest={latest}
        variant="default"
        onSubmitted={done}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" className="gap-2xs" />}
        >
          Remind me later
          <Icon icon={chevronIcon} className="icon-auto" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {LATER_CHOICES.map((choice) => (
            <Fragment key={choice.id}>
              {choice.id === "never" && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onClick={() => {
                  const write = laterWrite(choice.id, latest, new Date());
                  // A refused write (a config conflict, the preview) was
                  // announced with its fix; the reminder stays until it lands.
                  if (setConfig(write.key, write.value)) done();
                }}
              >
                {choice.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Line>
  );
}

/** `equin-update`: the update reminder's action (written by the daily check). */
export const updateReminderAction: NotificationActionKind = {
  kind: REMINDER_ACTION_KIND,
  label: "Send agent to update",
  Control: UpdateReminderControl,
  placement: "below",
};
