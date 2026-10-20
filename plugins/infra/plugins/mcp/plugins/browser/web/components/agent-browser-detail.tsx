import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type {
  AgentBrowserSession,
  AgentBrowserStatus,
  AgentBrowserUsage,
} from "../../core";
import { untilText } from "../internal/agent-browser-health";
import {
  useAgentBrowserStatus,
  useAgentBrowserUsage,
} from "../internal/use-agent-browser";

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

const ROLE_LABEL = {
  host: "host",
  browser: "browser",
  gpu: "GPU",
  renderer: "renderer",
  utility: "utility",
  other: "other",
} as const;

function mb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** `CPU 455% · RAM 3.4 GB — GPU 450% 632 MB · 8 renderers 25% 2.6 GB · …` */
function usageLine(u: AgentBrowserUsage): string | null {
  if (u.kind === "not-running") return null;
  if (u.kind === "unsupported") {
    return `CPU / RAM: host pid ${u.pid} predates usage reporting (replaced on main's next browser call)`;
  }
  const cpu = u.groups.reduce((n, g) => n + g.cpuPercent, 0);
  const rss = u.groups.reduce((n, g) => n + g.rssBytes, 0);
  const parts = u.groups.map(
    (g) =>
      `${g.processes > 1 ? `${g.processes} ` : ""}${ROLE_LABEL[g.role]}${g.processes > 1 ? "s" : ""} ${Math.round(g.cpuPercent)}% ${mb(g.rssBytes)}`,
  );
  return `CPU ${Math.round(cpu)}% · RAM ${mb(rss)} — ${parts.join(" · ")} (100% = one core, as of ${new Date(u.at).toLocaleTimeString()})`;
}

/**
 * The expanded row: the host process, and every conversation's session with
 * its tabs and when it closes if left idle. A died host's last-known sessions
 * are listed too — those are the ones whose writes the next launch reverts.
 */
export function AgentBrowserDetail(): ReactElement {
  const result = useAgentBrowserStatus();
  // Subscribed only while the row is open: each opening samples the host once.
  const usage = foldResource<
    ReturnType<typeof useAgentBrowserUsage>,
    ReactNode
  >(useAgentBrowserUsage(), {
    loading: () => (
      <Text variant="caption" tone="muted">
        CPU / RAM: measuring…
      </Text>
    ),
    error: (e) => (
      <ResourceErrorInline
        error={e}
        variant="inline"
        subject="the agent browser's CPU / RAM"
      />
    ),
    ready: (u) => {
      const text = usageLine(u);
      return text === null ? null : (
        <Text variant="caption" tone="muted">
          {text}
        </Text>
      );
    },
  });
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
                : s.tabs
                    .map(
                      (t) =>
                        `${t.id} ${t.title || t.url}${t.frozen ? " (frozen)" : ""}`,
                    )
                    .join(" · ")}
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
      {usage}
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
