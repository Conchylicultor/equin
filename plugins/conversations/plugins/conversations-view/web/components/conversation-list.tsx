import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { loadRouteForConversation } from "@plugins/conversations/plugins/pane-restore/web";
import {
  useOpenPane,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { closeConversation } from "@plugins/conversations/core";
import { ConversationsSidebarDataView } from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";

export function ConversationList() {
  const openPane = useOpenPane();
  const store = usePaneStore();
  const fetchEndpoint = useFetchEndpoint();

  // Highlight the conversation active in THIS surface's route — not the
  // focused window's URL. A background/secondary visible surface reflects its
  // own route. The conversation pane can appear more than once in a route; the
  // last instance is the one in focus.
  const entries = conversationPane.useRouteEntries();
  const activeId = entries[entries.length - 1]?.params.convId ?? null;

  const handleCloseConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetchEndpoint(closeConversation, { id });
  };

  // A row is a link: a plain click brings back the conversation's saved
  // layout (or opens it fresh), and a middle- / ⌘-click opens THAT SAME layout
  // in a new browser tab.
  const linkTo = (id: string): LinkTarget => {
    const fresh = openPane.to(
      conversationPane,
      { convId: id },
      { mode: "root" },
    );
    return {
      open: () => {
        const result = loadRouteForConversation(id);
        if (result.kind === "restored" && result.slots.length > 1) {
          store.restoreRoute(result.slots);
        } else {
          fresh.open();
        }
      },
      href: () => {
        const result = loadRouteForConversation(id);
        return result.kind === "restored" && result.slots.length > 1
          ? store.restoredRouteUrl(result.slots)
          : fresh.href();
      },
    };
  };

  // The merged DataView surface owns its own full-height root, so it fills
  // the sidebar column directly — no extra wrapper needed.
  return (
    <ConversationsSidebarDataView
      activeId={activeId}
      linkTo={linkTo}
      onCloseConversation={handleCloseConversation}
    />
  );
}
