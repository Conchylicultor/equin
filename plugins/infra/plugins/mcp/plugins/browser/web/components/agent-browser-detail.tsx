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
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
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

function SessionLine({
  session,
  now,
}: {
  session: AgentBrowserSession;
  now: number;
}) {
  const tabs = session.tabs.length;
  const soon = closesSoon(session.idleDeadline, now);
  // The list row is itself a flex line: this one fills it, and gives.
  return (
    <Fill>
      <Line className="gap-md">
        <Fill>
          <SessionName conversationId={session.conversationId} />
        </Fill>
        <Text
          variant="caption"
          tone={soon ? "default" : "faint"}
          className={cn(
            rigidClass(),
            "tabular-nums",
            soon ? "text-warning" : undefined,
          )}
          title="Closes when left idle this long"
        >
          {tabs} {tabs === 1 ? "tab" : "tabs"} ·{" "}
          {durationText(session.idleDeadline, now)}
        </Text>
      </Line>
    </Fill>
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
      },
      {
        id: "idleDeadline",
        label: "Closes",
        type: "date",
        value: (s) => new Date(s.idleDeadline),
        sortable: true,
      },
    ],
    [],
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
        viewOptions={{
          list: {
            renderRow: (s: AgentBrowserSession) => (
              <SessionLine session={s} now={now} />
            ),
          },
        }}
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
