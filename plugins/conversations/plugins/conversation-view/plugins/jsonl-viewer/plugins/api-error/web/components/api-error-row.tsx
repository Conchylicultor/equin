import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { EventLine } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  API_ERROR,
  AUTH_FAILED_ERROR,
  stopErrorLabel,
  USAGE_LIMIT_ERROR,
} from "@plugins/conversations/plugins/runtime-sdk/core";
import { ClaudeCodeFixWhileBlocked } from "@plugins/infra/plugins/claude-cli/plugins/sign-in/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResumeOnStop } from "./resume-on-stop";

const warningIcon = symbol("warning");

type ApiErrorEvent = Extract<JsonlEvent, { kind: "api-error" }>;

/** The eyebrow for the CLI's kind of failure: a usage limit reads as one. */
function labelOf(error: string | undefined): string {
  if (error === USAGE_LIMIT_ERROR) return "Usage limit";
  if (error === AUTH_FAILED_ERROR) return "Sign-in refused";
  const kind = stopErrorLabel(error);
  return kind === API_ERROR ? API_ERROR : `${API_ERROR} · ${kind}`;
}

export function ApiErrorRow({ event }: { event: JsonlEvent }) {
  const e = event as ApiErrorEvent;
  if (e.error === AUTH_FAILED_ERROR) return <AuthFailedRow event={e} />;
  // The CLI's text says everything the user needs (the limit and when it
  // resets, or what failed), so it is shown whole, never truncated.
  return (
    <EventLine
      icon={<Icon icon={warningIcon} className="size-3.5 text-warning" />}
      label={<span className="text-warning">{labelOf(e.error)}</span>}
    >
      <span className="text-foreground">{e.text}</span>
      <ResumeOnStop />
    </EventLine>
  );
}

/**
 * Claude refused the sign-in the agent ran on. The CLI's own text tells the
 * user to run `/login`, which cannot be done here — so the line says what
 * happened in the app's words and, while the computer's sign-in is still
 * refused (or signed out), draws the fix: Sign in and Check again, inline.
 * Once it is fixed the fix goes, and Resume brings the agent back.
 */
function AuthFailedRow({ event }: { event: ApiErrorEvent }) {
  return (
    <EventLine
      icon={<Icon icon={warningIcon} className="size-3.5 text-warning" />}
      label={<span className="text-warning">{labelOf(event.error)}</span>}
    >
      <Stack gap="xs">
        <span className="text-foreground">
          Claude refused the sign-in this agent ran on (it may have expired).
        </span>
        <ClaudeCodeFixWhileBlocked />
        <ResumeOnStop />
      </Stack>
    </EventLine>
  );
}
