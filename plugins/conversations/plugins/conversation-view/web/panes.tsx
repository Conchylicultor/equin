import { useLive } from "@plugins/network/plugins/live/web";
import {
  Pane,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { conversationsById } from "@plugins/tasks/plugins/tasks-core/core";
import { conversationRoute } from "@plugins/conversations/core";
import { useConversationById } from "@plugins/conversations/web";
import { ConversationView } from "./components/conversation-view";
import { ConversationTitle } from "./components/conversation-title";

// Found / missing from the `conversations.by-id` point read: any conversation,
// however old (W9) — no REST fallback. A failed read with nothing seen is the
// failure, with Retry — never a Not Found for a conversation that may exist.
function useResolveConversation({ convId }: { convId: string }): ResolveResult {
  return resolveRow(useLive(conversationsById, { id: convId }));
}

export const conversationPane = Pane.define({
  route: conversationRoute,
  app: agentManagerApp,
  component: ConversationView,
  width: 600,
  useResolve: useResolveConversation,
  // Tab/document title: the conversation's name from its by-id read. The
  // header paints the richer ConversationTitle (same source).
  title: { useText: useConversationTitle, component: ConversationTitle },
  // Main surface: aux panes opened to the right (file peek, review, terminal)
  // never steal the tab title from the conversation.
  titleOwner: true,
});

/** The conversation's title from its by-id read, or undefined. */
function useConversationTitle({
  convId,
}: {
  convId: string;
}): string | undefined {
  return useConversationById(convId)?.title ?? undefined;
}
