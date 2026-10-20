import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type {
  RowMenuHelpers,
  RowMenuItem,
} from "@plugins/primitives/plugins/tree/core";
import {
  AVATAR_COLOR_KEYS,
  DEFAULT_AGENT_AVATAR,
} from "@plugins/primitives/plugins/avatar/web";
import { avatarFieldDef } from "@plugins/fields/plugins/avatar/plugins/table/web";
import { useMultiSelect } from "@plugins/primitives/plugins/multi-select/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  createAgent,
  deleteAgent,
} from "@plugins/conversations/plugins/agents/core";
import { agentRows } from "../../core";
import type { Agent } from "../../core";
import { Agents as AgentsSlots } from "../slots";
import { agentDetailPane } from "../panes";
import { AgentStatus } from "./agent-status";
import { SystemFolder } from "./system-folder";
import { moveAgentTo, patchAgent } from "./patch-agent";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const deleteIcon = symbol("delete");

export { patchAgent } from "./patch-agent";

const AGENTS_LIST_VIEW = defineDataView("agents-list");

// The name is the entity's field (label and title flag included); the list says
// only that it edits in place.
const overrides = fieldOverrides(agentRows, {
  name: {
    onEdit: (a, next) =>
      patchAgent(a.id, {
        name: String(next ?? "").trim() || "Untitled",
      }),
  },
});

// The agent's avatar is a field, not a tree option: every view that has a
// leading slot draws it there, ahead of `leadingIcon`'s status dot. It is
// drawn from two columns, so the list computes it itself.
const extraFields: FieldDef<Agent>[] = [
  avatarFieldDef<Agent>({
    id: "avatar",
    label: "Avatar",
    leading: true,
    avatar: (a) => ({
      icon: a.icon ?? DEFAULT_AGENT_AVATAR.icon,
      color: a.iconColor ?? DEFAULT_AGENT_AVATAR.color,
      fallbackKey: a.id,
    }),
  }),
];

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

// Fields are listed explicitly rather than spread: a key the body schema doesn't
// declare is silently stripped at the boundary, which is exactly how `rank` used
// to vanish here — the new agent always landed at the end of the sibling list.
async function createAgentRow(args: {
  parentId: string | null;
  afterId?: string;
}): Promise<string | null> {
  const agent = await fetchEndpoint(
    createAgent,
    {},
    {
      body: {
        parentId: args.parentId,
        afterId: args.afterId,
        name: "New agent",
        prompt: "",
        iconColor: randomFrom(AVATAR_COLOR_KEYS),
      },
    },
  );
  return agent.id;
}

function DeleteSelectedAction() {
  const { selectedIds, clearAll } = useMultiSelect();
  const onClick = async () => {
    await Promise.all(
      [...selectedIds].map((id) => fetchEndpoint(deleteAgent, { id })),
    );
    clearAll();
  };
  return (
    <Button variant="destructive" onClick={() => onClick()}>
      <Icon icon={deleteIcon} />
      Delete
    </Button>
  );
}

export function AgentsList({
  selectedId,
  selectedSystemId,
  onSelect,
}: {
  selectedId?: string;
  selectedSystemId?: string;
  onSelect?: (id: string) => void;
}) {
  const result = useLive(agentRows);
  const openPane = useOpenPane();

  if (result.status === "loading") return <Loading variant="rows" />;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="block"
        subject="the agents"
        error={result.error}
        refetch={result.refetch}
      />
    );

  const rows = result.data;

  return (
    <Stack gap="xs">
      <SystemFolder selectedSystemId={selectedSystemId} />
      <DataView<Agent>
        rows={rows}
        collection={agentRows}
        overrides={overrides}
        extraFields={extraFields}
        rowKey={(a) => a.id}
        views={["table"]}
        storageKey={AGENTS_LIST_VIEW}
        selectedRowId={selectedId}
        rowActivation={(a) =>
          onSelect
            ? () => onSelect(a.id)
            : openPane.to(agentDetailPane, { id: a.id }, { mode: "push" })
        }
        // No expand hooks: expand/collapse is per-(surface, view-instance, row)
        // device-local render state owned by the data-view primitive, never a
        // domain field — so collapsing a node costs no PATCH and leaves the
        // agent's `updatedAt` alone.
        hierarchy={{
          getParentId: (a) => a.parentId,
          getRank: (a) => a.rank,
          // Positional intent only — the rows are a projection of the agents
          // table, so `moveAgent` mints the rank against the complete sibling set.
          onMove: (id, dest) => moveAgentTo(id, dest),
          onCreate: createAgentRow,
        }}
        selection={{ bulkActions: <DeleteSelectedAction /> }}
        itemActions={AgentsSlots.AgentActions}
        viewOptions={{
          table: {
            // The status dot follows the avatar field in the leading slot; both
            // inherit the DataView body's compact density.
            leadingIcon: (a: Agent) => <AgentStatus agentId={a.id} />,
            rowMenu: ({ addBelow }: RowMenuHelpers): RowMenuItem[] => [
              {
                icon: addIcon,
                label: "Add agent below",
                onClick: () => void addBelow(),
              },
            ],
            expandAll: true,
            addLabel: "Agent",
            toolbarStart: <AgentsSlots.ListActions.Render />,
            dragOverlay: (a: Agent) => a.name || "Untitled",
          },
        }}
      />
    </Stack>
  );
}
