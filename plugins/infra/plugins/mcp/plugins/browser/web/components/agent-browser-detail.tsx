import { useMemo, type ReactElement } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { AgentBrowserSession, AgentBrowserStatus } from "../../core";
import { untilText } from "../internal/agent-browser-health";
import { useAgentBrowserStatus } from "../internal/use-agent-browser";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const SESSIONS_VIEW = defineDataView("agent-browser.sessions");

const NO_SESSIONS: AgentBrowserSession[] = [];

function hostLine(s: AgentBrowserStatus, now: number): string | null {
  if (s.kind !== "running") return null;
  const { pid, startedAt, idleExitAt, codeId, drives } = s.host;
  const since = new Date(startedAt).toLocaleTimeString();
  const exit =
    idleExitAt === null
      ? ""
      : ` · exits ${untilText(idleExitAt, now)} unless used`;
  const driving =
    drives.running + drives.waiting === 0
      ? ""
      : ` · ${drives.running} driving, ${drives.waiting} waiting for a browser slot`;
  return `Host pid ${pid}, up since ${since}, code ${codeId}${exit}${driving}`;
}

/**
 * The expanded row: the host process, and every conversation's session with
 * its tabs and when it closes if left idle. A died host's last-known sessions
 * are listed too — those are the ones whose writes the next launch reverts.
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
  const errors =
    status !== null && status.kind === "running" ? status.host.errors : [];
  const last = errors.at(-1);

  const fields = useMemo<FieldDef<AgentBrowserSession>[]>(
    () => [
      {
        id: "conversationId",
        label: "Conversation",
        type: "text",
        primary: true,
        value: (s) => s.conversationId,
        cell: (s) => (
          <Stack gap="none">
            {/* Plain text: InlineText's file-links walker needs a pane
                surface, and the health report is global chrome. */}
            <Text variant="code" className="truncate">
              {s.conversationId}
            </Text>
            <Text variant="caption" tone="muted" className="truncate">
              {s.tabs.length === 0
                ? "no tabs"
                : s.tabs.map((t) => `${t.id} ${t.title || t.url}`).join(" · ")}
            </Text>
          </Stack>
        ),
        width: "minmax(0,1fr)",
      },
      {
        id: "target",
        label: "Target",
        type: "text",
        value: (s) => s.target ?? "",
        cell: (s) => (
          <Text variant="caption" tone="muted" className="truncate">
            {s.target === null ? "unbuilt" : new URL(s.target).host}
          </Text>
        ),
        width: "12rem",
      },
      {
        id: "tabs",
        label: "Tabs",
        type: "number",
        value: (s) => s.tabs.length,
        align: "end",
        width: "4rem",
      },
      {
        id: "idleDeadline",
        label: "Closes",
        type: "date",
        value: (s) => new Date(s.idleDeadline),
        cell: (s) => (
          <Text variant="caption" tone="muted">
            {untilText(s.idleDeadline, now)}
          </Text>
        ),
        sortable: true,
        align: "end",
        width: "6rem",
      },
    ],
    [now],
  );

  const line = status === null ? null : hostLine(status, now);
  return (
    <Stack gap="sm">
      {line !== null && (
        <Text variant="caption" tone="muted">
          {line}
        </Text>
      )}
      {last !== undefined && (
        <Text variant="caption" tone="muted" title={last.message}>
          Last host error ({new Date(last.at).toLocaleTimeString()},{" "}
          {last.during}): {last.message.split("\n", 1)[0]}
        </Text>
      )}
      <DataView<AgentBrowserSession>
        rows={sessions}
        fields={fields}
        rowKey={(s) => s.conversationId}
        storageKey={SESSIONS_VIEW}
        views={["list"]}
        readiness={result}
        emptyState="No open sessions."
      />
    </Stack>
  );
}
