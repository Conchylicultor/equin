import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Shell } from "@plugins/shell/web";
import { opensPane } from "@plugins/primitives/plugins/app-shell/web";
import { Item } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import {
  agentsRootPane,
  agentDetailPane,
  systemAgentDetailPane,
  agentSidePane,
} from "./panes";
import { AgentAvatarRow } from "./components/agent-avatar-row";
import { AgentAvatarTitlePrefix } from "./components/agent-avatar-title-prefix";
import { DeleteAgentAction } from "./components/delete-agent-action";
import { ExpandAgentButton } from "./components/expand-agent-button";
import { Agents as AgentsSlots } from "./slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { IdKinds } from "@plugins/ids/web";
import { agentIdKind, agentLaunchIdKind } from "../core";

export {
  agentsRootPane,
  agentDetailPane,
  systemAgentDetailPane,
  agentSidePane,
} from "./panes";
export { Agents } from "./slots";
export { defineSystemAgent } from "./system-agents";
export type { SystemAgentDescriptor } from "./system-agents";
export { patchAgent } from "./components/agents-list";

export default {
  description: "Named agent definitions that launch conversations.",
  contributions: [
    IdKinds.Kind({ kind: agentIdKind }),
    IdKinds.Kind({ kind: agentLaunchIdKind }),
    Pane.Register({ pane: agentsRootPane }),
    Pane.Register({ pane: agentDetailPane }),
    Pane.Register({ pane: systemAgentDetailPane }),
    Pane.Register({ pane: agentSidePane }),
    agentSidePane.Actions({ id: "expand-agent", component: ExpandAgentButton }),
    Shell.Sidebar({
      id: "agents",
      title: "Agents",
      icon: symbol("precision-manufacturing"),
      opens: opensPane(agentsRootPane, {}),
    }),
    Item.Avatar({
      match: ({ conv }) => conv.kind === "agent",
      component: AgentAvatarRow,
    }),
    conversationPane.Actions({
      id: "agent-avatar",
      component: AgentAvatarTitlePrefix,
    }),
    AgentsSlots.AgentActions({ id: "delete", component: DeleteAgentAction }),
  ],
  slots: {
    ...AgentsSlots,
    "agents-root": agentsRootPane,
    "agent-detail": agentDetailPane,
    "agent-system-detail": systemAgentDetailPane,
    "agent-side": agentSidePane,
  },
} satisfies PluginDefinition;
