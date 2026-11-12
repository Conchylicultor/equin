import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const webhookIcon = symbol("webhook");

interface HookErrorPayload {
  type: string;
  hookName?: string;
  hookEvent?: string;
  toolUseID?: string;
  content?: string;
  /** Only `hook_stopped_continuation` carries this: the guard's explanation of
   *  why it cut the turn short. It IS the row's content, so it takes the place
   *  stderr holds for the command-shaped subtypes. */
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  command?: string;
  durationMs?: number;
}

// Failure counterpart to HookSuccessView: a hook that errored, blocked, was
// cancelled, or stopped the agent mid-turn. Shown loud — destructive chrome,
// always expanded — so the failure (and what it said) is visible without a
// click. `hook_stopped_continuation` belongs here rather than in a plugin of
// its own: a guard cutting the turn short is a loud hook outcome, and splitting
// it out would give the same family two different chromes.
function labelFor(subtype: string): string {
  switch (subtype) {
    case "hook_non_blocking_error":
      return "Hook error";
    case "hook_blocking_error":
      return "Hook blocked";
    case "hook_cancelled":
      return "Hook cancelled";
    case "hook_stopped_continuation":
      return "Hook stopped the agent";
    default:
      return "Hook error";
  }
}

export function HookErrorView({ event }: AttachmentRendererProps) {
  const att = event.attachment as HookErrorPayload;
  const exitCode = att.exitCode;
  const stderr = att.stderr?.trim();
  const stdout = att.stdout?.trim();
  const message = att.message?.trim();
  const hook = att.hookName ?? att.hookEvent;
  const label = hook
    ? `${labelFor(event.subtype)} · ${hook}`
    : labelFor(event.subtype);

  return (
    <CollapsibleCard
      icon={<Icon icon={webhookIcon} className="size-3.5" />}
      error
      defaultOpen
      label={label}
      note={
        typeof att.durationMs === "number" ? `· ${att.durationMs}ms` : undefined
      }
    >
      <Stack as="div" gap="2xs" className="font-mono text-muted-foreground">
        {att.command && (
          <Text as="p" variant="caption" className="break-all">
            $ {att.command}
          </Text>
        )}
        {typeof exitCode === "number" && (
          <Text as="p" variant="caption" className="text-destructive">
            exit {exitCode}
          </Text>
        )}
        {message && (
          <Text
            as="p"
            variant="caption"
            className="whitespace-pre-wrap break-words text-destructive"
          >
            {message}
          </Text>
        )}
        {stderr && (
          <Text
            as="p"
            variant="caption"
            className="whitespace-pre-wrap break-words text-destructive"
          >
            {stderr}
          </Text>
        )}
        {stdout && (
          <Text
            as="p"
            variant="caption"
            className="whitespace-pre-wrap break-words"
          >
            {stdout}
          </Text>
        )}
      </Stack>
    </CollapsibleCard>
  );
}
