import type { ReactElement } from "react";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  sendConversationTurn,
  useOptimisticConversationStatus,
} from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { outcomeReportRows } from "../../core";
import { OutcomeReportView } from "./outcome-report-view";

/**
 * The report at the end of the transcript of the conversation that submitted
 * it — scrolling with the transcript, never pinned over it.
 * Answering its question sends the chosen label as the user's next turn,
 * through the ordinary send path; the buttons are live only while the agent
 * waits for input (the optimistic status flips to working on click).
 */
export function OutcomeReportCard({
  conversation,
}: {
  conversation: ConversationRecord;
}): ReactElement | null {
  const result = useLiveRow(outcomeReportRows, conversation.taskId);
  const status = useOptimisticConversationStatus(conversation);
  // Not loaded yet and "no report" both render nothing: an optional banner.
  if (result.status === "loading") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the outcome report"
        error={result.error}
        refetch={result.refetch}
      />
    );
  if (!result.found) return null;
  const report = result.row;
  // A task's report belongs to the conversation that wrote it; a sibling
  // conversation of the same task must not answer for it.
  if (report.conversationId !== conversation.id) return null;
  return (
    <Card>
      <OutcomeReportView
        report={report}
        answer={{
          choose: (label) => {
            sendConversationTurn(conversation.id, { text: label });
          },
          disabled: status !== "waiting",
        }}
      />
    </Card>
  );
}

/**
 * One task's outcome report, read-only — for surfaces listing automated tasks
 * (the automation's History rows), with its loading and "no report yet" states.
 */
export function OutcomeReportDetail({
  taskId,
}: {
  taskId: string;
}): ReactElement {
  const result = useLiveRow(outcomeReportRows, taskId);
  if (result.status === "loading") return <Loading />;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the outcome report"
        error={result.error}
        refetch={result.refetch}
      />
    );
  if (!result.found)
    return (
      <Text variant="caption" tone="muted">
        No outcome report yet.
      </Text>
    );
  return <OutcomeReportView report={result.row} />;
}
