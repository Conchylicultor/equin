import { useWholeTranscript } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  buildAggregate,
  conversationTaskAggregate,
  type TaskAggregate,
} from "../../core";

export type { TaskAggregate, TaskEntry } from "../../core";

/**
 * The task list of the transcript the enclosing view draws — a sub-agent
 * pane's own tasks, not the parent conversation's; a conversation's over its
 * whole transcript, read from the server.
 */
export function useTaskAggregate(): ResourceResult<TaskAggregate> {
  return useWholeTranscript(conversationTaskAggregate, buildAggregate);
}
