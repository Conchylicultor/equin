import type { ReactElement } from "react";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveRow,
  rowOrStale,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { AgentSideBody } from "./components/agent-side-body";
import { agentRows } from "../core";
import { Agents as AgentsSlots } from "./slots";
import { AgentsList } from "./components/agents-list";
import { AgentDetail } from "./components/agent-detail";
import { SystemAgentDetail } from "./components/system-agent-detail";

const agentsRootRoute = defineRoute({
  id: "agents-root",
  segment: "agents",
});

export const agentsRootPane = Pane.define({
  route: agentsRootRoute,
  app: agentManagerApp,
  title: "Agents",
  component: AgentsRoot,
  width: 320,
});

/** The agent's name, or undefined until it is known (the title's fallback shows). */
function useAgentName(id: string): string | undefined {
  return rowOrStale(useLiveRow(agentRows, id))?.name;
}

function useAgentDetailTitle({ id }: { id: string }): string | undefined {
  return useAgentName(id);
}

function useAgentSideTitle({
  agentId,
}: {
  agentId: string;
}): string | undefined {
  return useAgentName(agentId);
}

/** The system agent's registered name, or undefined when none has that id. */
function useSystemAgentTitle({
  systemId,
}: {
  systemId: string;
}): string | undefined {
  return AgentsSlots.SystemAgent.useContributions().find(
    (d) => d.id === systemId,
  )?.name;
}

function useResolveAgent({ id }: { id: string }): ResolveResult {
  return resolveRow(useLiveRow(agentRows, id));
}

export const agentDetailPane = Pane.define({
  route: defineRoute({
    id: "agent-detail",
    segment: "ag/:id",
    parent: agentsRootRoute,
  }),
  app: agentManagerApp,
  component: AgentDetailBody,
  title: { useText: useAgentDetailTitle, fallback: "Agent" },
  width: 360,
  useResolve: useResolveAgent,
});

export const systemAgentDetailPane = Pane.define({
  route: defineRoute({
    id: "agent-system-detail",
    segment: "system/:systemId",
    parent: agentsRootRoute,
  }),
  app: agentManagerApp,
  component: SystemAgentDetailBody,
  title: { useText: useSystemAgentTitle, fallback: "Unknown system agent" },
  useResolve: false,
});

export const agentSidePane = Pane.define({
  route: defineRoute({
    id: "agent-side",
    segment: "agent/:agentId",
  }),
  app: agentManagerApp,
  component: AgentSideBody,
  title: { useText: useAgentSideTitle, fallback: "Agent" },
  chrome: {
    history: false,
    promote: false,
  },
  useResolve: false,
});

function AgentsRoot(): ReactElement {
  const selectedUserId = agentDetailPane.useRouteEntry()?.params.id;
  const selectedSystemId =
    systemAgentDetailPane.useRouteEntry()?.params.systemId;

  return (
    <PaneChrome pane={agentsRootPane}>
      <Inset pad="lg">
        <AgentsList
          selectedId={selectedUserId}
          selectedSystemId={selectedSystemId}
        />
        {/* eslint-disable-next-line spacing/no-adhoc-spacing -- top offset separating the slot section from the agents list above */}
        <Stack gap="lg" className="mt-6">
          <AgentsSlots.List.Render />
        </Stack>
      </Inset>
    </PaneChrome>
  );
}

function AgentDetailBody(): ReactElement {
  const { id } = agentDetailPane.useParams();

  return (
    <PaneChrome pane={agentDetailPane}>
      <AgentDetail key={id} agentId={id} />
      <Stack gap="lg" className="px-xl pb-xl">
        <AgentsSlots.View.Render>
          {(v) => (
            <Surface level="raised" as="section" className="p-lg">
              {v.title ? (
                // eslint-disable-next-line spacing/no-adhoc-spacing -- bottom offset separating the section title from its body
                <Text as="h2" variant="label" className="mb-4">
                  {v.title}
                </Text>
              ) : null}
              <v.component agentId={id} />
            </Surface>
          )}
        </AgentsSlots.View.Render>
      </Stack>
    </PaneChrome>
  );
}

function SystemAgentDetailBody(): ReactElement {
  const { systemId } = systemAgentDetailPane.useParams();
  const descriptors = AgentsSlots.SystemAgent.useContributions();
  const descriptor = descriptors.find((d) => d.id === systemId);

  if (!descriptor) {
    return (
      <PaneChrome pane={systemAgentDetailPane}>
        <Placeholder>
          No system agent registered with id <code>{systemId}</code>.
        </Placeholder>
      </PaneChrome>
    );
  }

  return (
    <PaneChrome pane={systemAgentDetailPane}>
      <AgentsSlots.SystemAgent.Render>
        {(d) =>
          d.id === systemId ? (
            d.component ? (
              <d.component descriptor={d} />
            ) : (
              <SystemAgentDetail descriptor={d} />
            )
          ) : null
        }
      </AgentsSlots.SystemAgent.Render>
    </PaneChrome>
  );
}
