import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { CONV_STATUS_DOT } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { agentLaunchRows } from "../../core";

export function AgentStatus({ agentId }: { agentId: string }) {
  const launchesQ = useLive(agentLaunchRows);

  // No status while loading is correct — we don't know the latest status yet.
  if (launchesQ.status === "loading") {
    return <Center as="span" style={{ width: 20, height: 20 }} />;
  }
  if (launchesQ.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the agent's status"
        error={launchesQ.error}
        refetch={launchesQ.refetch}
      />
    );
  }

  const latest = launchesQ.data
    .filter((l) => l.agentId === agentId)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  const status = latest?.latestConversationStatus ?? null;

  return (
    <Center as="span" style={{ width: 20, height: 20 }}>
      {status && <StatusDot {...CONV_STATUS_DOT[status]} />}
    </Center>
  );
}
