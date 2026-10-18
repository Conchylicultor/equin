import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { CONV_STATUS_DOT } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/core";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  agentLaunchRows,
  type AgentLaunchWithStatus,
} from "../../shared/resources";

const AGENT_LAUNCHES_VIEW = defineDataView("agent-launches");

function formatDate(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Conversation statuses, in lifecycle order — drives the enum field's chip
// label + the filter/group-by option list. Mirrors ConversationStatusSchema.
const STATUS_OPTIONS = [
  { value: "starting", label: "Starting" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "gone", label: "Gone" },
  { value: "done", label: "Done" },
];

function launchTitle(launch: AgentLaunchWithStatus): string {
  return (
    launch.latestConversation?.title ?? `Launch ${formatDate(launch.createdAt)}`
  );
}

// The fields the list computes itself: the title and status come from the
// launch's joined latest conversation, not from a column. (The `agent-launches`
// collection lists no field of its own.)
const EXTRA_FIELDS: FieldDef<AgentLaunchWithStatus>[] = [
  {
    id: "title",
    label: "Conversation",
    primary: true,
    value: (l) => launchTitle(l),
  },
  {
    id: "status",
    label: "Status",
    type: "enum",
    align: "end",
    options: STATUS_OPTIONS,
    value: (l) => l.latestConversation?.status ?? null,
  },
  {
    id: "started",
    label: "Started",
    type: "date",
    align: "end",
    value: (l) => l.createdAt,
  },
];

export function AgentLaunches({ agentId }: { agentId: string }) {
  const launchesQ = useLive(agentLaunchRows);
  const openPane = useOpenPane();
  const convEntry = conversationPane.useRouteEntry();
  const activeConvId = convEntry?.params.convId;

  if (launchesQ.status === "loading") return <Loading variant="text" />;
  if (launchesQ.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the attempts"
        error={launchesQ.error}
        refetch={launchesQ.refetch}
      />
    );

  const launches = launchesQ.data.filter((l) => l.agentId === agentId);

  // Highlight the row whose conversation is the one open in the pane.
  const selectedRowId = launches.find(
    (l) => l.latestConversation?.id === activeConvId,
  )?.id;

  return (
    <Stack as="section" gap="sm">
      <SectionLabel as="h3" className="font-medium">
        Attempts
      </SectionLabel>
      <DataView<AgentLaunchWithStatus>
        rows={launches}
        collection={agentLaunchRows}
        extraFields={EXTRA_FIELDS}
        rowKey={(l) => l.id}
        views={["list"]}
        storageKey={AGENT_LAUNCHES_VIEW}
        selectedRowId={selectedRowId}
        emptyState={<Text tone="muted">No attempts yet.</Text>}
        onRowActivate={(l) => {
          const primary = l.latestConversation;
          if (!primary) return;
          if (activeConvId === primary.id && convEntry) {
            conversationPane.close(convEntry.instanceId);
          } else {
            openPane(
              conversationPane,
              { convId: primary.id },
              { mode: "push" },
            );
          }
        }}
        viewOptions={{
          list: {
            leading: (l: AgentLaunchWithStatus) => (
              <StatusDot
                {...(l.latestConversation
                  ? CONV_STATUS_DOT[l.latestConversation.status]
                  : { colorClass: "bg-muted-foreground/40" })}
              />
            ),
          },
        }}
      />
    </Stack>
  );
}
