import { useMemo, type ReactElement, type ReactNode } from "react";
import { useConversationById } from "@plugins/conversations/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { AgentBrowserSession } from "../../core";
import {
  closesSoon,
  durationText,
  RECENT_ERROR_MS,
} from "../internal/agent-browser-health";
import { useAgentBrowserStatus } from "../internal/use-agent-browser";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const SESSIONS_VIEW = defineDataView("agent-browser.sessions");

const NO_SESSIONS: AgentBrowserSession[] = [];

/**
 * A handful of sessions in a popover needs no view switcher, search or filter
 * strip: the frame draws the body alone. Module scope, so its identity is
 * stable.
 */
function SessionsFrame({ body }: HostedToolbarParts): ReactNode {
  return body;
}

const SESSIONS_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: SessionsFrame,
};

/** What the session is for: its task's title, else the conversation's own. */
function SessionName({ conversationId }: { conversationId: string }) {
  const entry = useConversationById(conversationId);
  // Plain text: InlineText's file-links walker needs a pane surface, and the
  // health report is global chrome. Until the row resolves, the id names it.
  const name =
    entry === null
      ? conversationId
      : entry.taskTitle.trim() || entry.title?.trim() || conversationId;
  return (
    <Text variant="caption" className="truncate" title={conversationId}>
      {name}
    </Text>
  );
}

/**
 * The expanded row: one line per conversation's session — what it is for,
 * its tabs, and how long until it closes if left idle — and the latest
 * failure the host hit on its own while it is recent. A died host's
 * last-known sessions are listed too: those are the ones whose writes the
 * next launch reverts.
 */
export function AgentBrowserDetail(): ReactElement {
  const result = useAgentBrowserStatus();
  const now = useNow(30_000);
  const status = foldResource(result, {
    loading: () => null,
    error: () => null,
    ready: (d) => d,
  });
  const sessions =
    status !== null && (status.kind === "running" || status.kind === "died")
      ? status.host.sessions
      : NO_SESSIONS;
  const last =
    status !== null && status.kind === "running"
      ? status.host.errors.at(-1)
      : undefined;
  const recentError =
    last !== undefined && now - Date.parse(last.at) < RECENT_ERROR_MS
      ? last
      : undefined;

  const fields = useMemo<FieldDef<AgentBrowserSession>[]>(
    () => [
      {
        id: "conversationId",
        label: "Session",
        type: "text",
        primary: true,
        value: (s) => s.conversationId,
        cell: (s) => <SessionName conversationId={s.conversationId} />,
      },
      {
        id: "tabs",
        label: "Tabs",
        type: "number",
        value: (s) => s.tabs.length,
        cell: (s) => (
          <Text variant="caption" tone="faint" className="tabular-nums">
            {s.tabs.length} {s.tabs.length === 1 ? "tab" : "tabs"}
          </Text>
        ),
      },
      {
        id: "idleDeadline",
        label: "Closes",
        type: "date",
        value: (s) => new Date(s.idleDeadline),
        // The countdown, flagged in its last minutes — ticks with `now`.
        cell: (s) => (
          <Text
            variant="caption"
            tone={closesSoon(s.idleDeadline, now) ? "default" : "faint"}
            className={cn(
              "tabular-nums",
              closesSoon(s.idleDeadline, now) ? "text-warning" : undefined,
            )}
            title="Closes when left idle this long"
          >
            {durationText(s.idleDeadline, now)}
          </Text>
        ),
        sortable: true,
      },
    ],
    [now],
  );

  return (
    <Stack gap="xs">
      <DataView<AgentBrowserSession>
        rows={sessions}
        fields={fields}
        rowKey={(s) => s.conversationId}
        storageKey={SESSIONS_VIEW}
        views={["list"]}
        toolbar={SESSIONS_TOOLBAR}
        readiness={result}
        emptyState="No open sessions."
      />
      {recentError !== undefined && (
        <Text
          variant="caption"
          className="truncate text-warning"
          title={`${recentError.during}: ${recentError.message}`}
        >
          {recentError.message.split("\n", 1)[0]}
          <span className="text-muted-foreground">
            {" "}
            ·{" "}
            {new Date(recentError.at).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </Text>
      )}
    </Stack>
  );
}
