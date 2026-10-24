import { useConversations } from "@plugins/conversations/web";
import type { ConversationEntry } from "@plugins/conversations/core";
import type { MenuBarStatus } from "@plugins/menu-bar/web";

/** The two counts the agent manager's home shows: running, and waiting on you. */
function partition(active: readonly ConversationEntry[]) {
  return {
    running: active.filter(
      (c) => c.status === "working" || c.status === "starting",
    ).length,
    needsYou: active.filter((c) => c.status === "waiting").length,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 agents working · 1 needs you"; nothing to say when no agent is busy. */
export function useAgentsStatus(): MenuBarStatus {
  const conv = useConversations();
  if (conv.status === "loading") return { kind: "pending" };
  if (conv.status === "error") return { kind: "failed", subject: "agents" };
  const { running, needsYou } = partition(conv.data.active);
  const parts = [
    running > 0 ? `${plural(running, "agent", "agents")} working` : null,
    needsYou > 0 ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : null,
  ].filter((p): p is string => p !== null);
  return {
    kind: "ready",
    text: parts.length > 0 ? parts.join(" · ") : null,
    attention: needsYou > 0,
  };
}
