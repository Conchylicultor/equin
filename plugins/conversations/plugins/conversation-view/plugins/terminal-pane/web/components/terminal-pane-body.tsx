import { useEffect, useMemo, useRef, useState } from "react";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { terminalPane } from "@plugins/primitives/plugins/terminal/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";

const TMUX = "tmux";

export function TerminalPaneBody() {
  const convId = conversationPane.useRouteEntry()?.params.convId;
  const conversation = useConversationById(convId ?? null);
  if (!conversation) return null;
  return (
    <TerminalPaneInner convId={conversation.id} status={conversation.status} />
  );
}

function TerminalPaneInner({
  convId,
  status,
}: {
  convId: string;
  status: string;
}) {
  const TerminalComponent = useMemo(
    () =>
      terminalPane({
        // The pane only shows the agent's log: attached read-only, so a
        // Ctrl-C typed into it never reaches the agent process.
        command: [TMUX, "-u", "attach", "-r", "-t", convId],
        title: convId,
      }).component,
    [convId],
  );

  // After Resume re-spawns the tmux session, the existing PTY (which exited
  // when the original session died) has to be replaced — bump a key whenever
  // the conversation transitions from gone to live so the TerminalComponent
  // remounts and reattaches.
  const [reattachKey, setReattachKey] = useState(0);
  const wasDisconnected = status === "gone" || status === "done";
  const wasDisconnectedRef = useRef(wasDisconnected);
  useEffect(() => {
    if (wasDisconnectedRef.current && !wasDisconnected) {
      setReattachKey((k) => k + 1);
    }
    wasDisconnectedRef.current = wasDisconnected;
  }, [wasDisconnected]);

  return (
    <Clip fill className="h-full">
      <TerminalComponent key={reattachKey} />
    </Clip>
  );
}
