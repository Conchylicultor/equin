import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { statusDotPaintClass } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import {
  Avatar,
  DEFAULT_AGENT_AVATAR,
} from "@plugins/primitives/plugins/avatar/web";
import {
  CONV_STATUS_DOT,
  type ConversationItemConv,
} from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { agentLaunchRows, agentRows } from "../../core";

export function AgentAvatarRow({ conv }: { conv: ConversationItemConv }) {
  const launchesResult = useLive(agentLaunchRows);
  const agentsResult = useLive(agentRows);
  const combined = useCombinedResources({
    launches: launchesResult,
    agents: agentsResult,
  });
  if (conv.kind !== "agent" || !conv.taskId) return null;
  if (combined.status === "loading") return null;
  if (combined.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the agent"
        error={combined.error}
        refetch={combined.refetch}
      />
    );
  const { launches, agents } = combined.data;
  const launch = launches.find((l) => l.taskId === conv.taskId);
  const agent = launch ? agents.find((a) => a.id === launch.agentId) : null;
  return (
    <Avatar
      icon={agent?.icon ?? DEFAULT_AGENT_AVATAR.icon}
      statusDot={statusDotPaintClass(CONV_STATUS_DOT[conv.status])}
      title={agent?.name}
      colorless
    />
  );
}
