import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  Avatar,
  DEFAULT_AGENT_AVATAR,
} from "@plugins/primitives/plugins/avatar/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import {
  agentLaunchRows,
  agentRows,
  type Agent,
  type AgentLaunchWithStatus,
} from "../../core";
import { agentSidePane } from "../panes";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

export function AgentAvatarTitlePrefix() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const launchesResult = useLive(agentLaunchRows);
  const agentsResult = useLive(agentRows);
  const combined = useCombinedResources({
    launches: launchesResult,
    agents: agentsResult,
  });

  if (!conversation || conversation.kind !== "agent") return null;
  // Render disabled-neutral button while both resources load — never a wrong default.
  if (combined.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the agent"
        error={combined.error}
        refetch={combined.refetch}
      />
    );
  }
  if (combined.status === "loading") {
    return (
      <button
        type="button"
        disabled
        aria-pressed={false}
        title="Agent"
        className="pointer-events-none cursor-default rounded-full opacity-60 transition-opacity"
      >
        <Avatar
          icon={DEFAULT_AGENT_AVATAR.icon}
          color={DEFAULT_AGENT_AVATAR.color}
        />
      </button>
    );
  }

  return (
    <AgentAvatarTitlePrefixInner
      taskId={conversation.taskId}
      launches={combined.data.launches}
      agents={combined.data.agents}
    />
  );
}

function AgentAvatarTitlePrefixInner({
  taskId,
  launches,
  agents,
}: {
  taskId: string | null;
  launches: AgentLaunchWithStatus[];
  agents: Agent[];
}) {
  const launch = launches.find((l) => l.taskId === taskId);
  const agent = launch ? agents.find((a) => a.id === launch.agentId) : null;
  const agentId = launch?.agentId;
  const { isOpen, toggle } = agentSidePane.useToggle({
    agentId: agentId ?? "",
  });

  return (
    <button
      type="button"
      disabled={!agentId}
      aria-pressed={isOpen}
      title={agent?.name ?? "Agent"}
      onClick={toggle}
      className={cn(
        "rounded-full transition-opacity",
        isOpen
          ? "opacity-100 ring-2 ring-ring ring-offset-1 ring-offset-background"
          : "hover:opacity-80",
        !agentId && "pointer-events-none cursor-default opacity-60",
      )}
    >
      <Avatar
        icon={agent?.icon ?? DEFAULT_AGENT_AVATAR.icon}
        color={agent?.iconColor ?? DEFAULT_AGENT_AVATAR.color}
        fallbackKey={agent?.id}
      />
    </button>
  );
}
