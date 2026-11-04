import { rowOrStale } from "@plugins/network/plugins/live/web";
import { useEffect, useRef } from "react";
import { setActiveRelateContext } from "@plugins/tasks/plugins/task-draft-form/web";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { useConversationById } from "@plugins/conversations/web";
import { conversationPane } from "../panes";

export function ActiveRelateSync() {
  const { convId } = conversationPane.useParams();
  const conversation = rowOrStale(useConversationById(convId));
  const surfaceId = useSurfaceTabId();
  const ownerRef = useRef(Symbol());

  useEffect(() => {
    if (!surfaceId) return;
    const owner = ownerRef.current;
    if (conversation?.taskId) {
      setActiveRelateContext(surfaceId, owner, { taskId: conversation.taskId });
    }
    return () => setActiveRelateContext(surfaceId, owner, null);
  }, [surfaceId, conversation?.taskId]);

  return null;
}
