import { useState } from "react";
import {
  limitStoppedConversations,
  resumeLimitedConversations,
} from "@plugins/conversations/plugins/runtime-sdk/core";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/**
 * Resume, on a usage-limit line — shown while this conversation is still
 * stopped at the limit (a turn since, or a restart, takes it out of the set,
 * and the button goes with it). The resume turn's send restarts the agent on
 * the account a launch picks now.
 */
export function ResumeOnLimit() {
  const conversationId = useJsonlConversationId();
  const stopped = useLiveRow(limitStoppedConversations, conversationId);
  const [error, setError] = useState<string | null>(null);
  if (conversationId === null) return null;
  // Not stopped (or not known yet, or unreadable): this line is history, and
  // the conversation's own prompt still resumes it.
  if (stopped.status === "loading" || stopped.status === "error") return null;
  if (!stopped.found) return null;
  const resume = async () => {
    setError(null);
    const answer = await fetchEndpoint(
      resumeLimitedConversations,
      {},
      { body: { ids: [conversationId] } },
    );
    if (answer.kind === "unavailable") {
      setError(answer.message);
      return;
    }
    const failed = answer.value.results.find((r) => r.kind === "failed");
    if (failed) setError(failed.message);
  };
  return (
    <>
      <Button variant="outline" onClick={resume}>
        Resume
      </Button>
      {error ? (
        <Text variant="caption" tone="destructive">
          {error}
        </Text>
      ) : null}
    </>
  );
}
