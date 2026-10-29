import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  FieldDef,
  FieldOption,
} from "@plugins/primitives/plugins/data-view/core";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { agentLaunchRows, type AgentLaunchWithStatus } from "../../core";

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
const STATUS_OPTIONS: FieldOption[] = [
  {
    value: "starting",
    label: "Starting",
    variant: "info",
    icon: symbol("timelapse"),
  },
  {
    value: "working",
    label: "Working",
    variant: "info",
    icon: symbol("timelapse"),
  },
  {
    value: "waiting",
    label: "Waiting",
    variant: "warning",
    icon: symbol("input"),
  },
  { value: "gone", label: "Gone", variant: "muted", icon: symbol("cancel") },
  {
    value: "done",
    label: "Done",
    variant: "success",
    icon: symbol("check-circle"),
  },
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
    options: STATUS_OPTIONS,
    value: (l) => l.latestConversation?.status ?? null,
  },
  {
    id: "started",
    label: "Started",
    type: "date",
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
      />
    </Stack>
  );
}
