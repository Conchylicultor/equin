import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { transcriptToolCall } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { useWorkflowTrace } from "./use-workflow-trace";
import type { TracedGraph, TracedNode, TraceStatus } from "./trace-types";

interface WorkflowInput {
  script?: string;
  args?: unknown;
}

export type WorkflowNodeState =
  // The transcript is not known yet.
  | { phase: "loading" }
  // The transcript read failed.
  | { phase: "failed"; error: ResourceError; retry: () => Promise<void> }
  // No conversation pane above this one: there is no transcript to read
  // (skipped), a settled answer — never a spinner.
  | { phase: "no-conversation" }
  | {
      phase: "found";
      graph: TracedGraph | null;
      status: TraceStatus;
      node: TracedNode | undefined;
    };

/**
 * One step of a Workflow tool call: the call itself (`transcriptToolCall`,
 * read by id from the conversation's transcript, whether or not its pane
 * holds it) → the call's script → its traced DAG → the node.
 *
 * Reads only its arguments and global resources, so it serves both the pane
 * body and the pane's `title.text` (which runs outside the app's providers).
 * `convId` is `undefined` when no conversation pane sits above this one.
 */
export function useWorkflowNode(
  convId: string | undefined,
  toolUseId: string,
  nodeId: string,
): WorkflowNodeState {
  const eventsResult = useLive(
    transcriptToolCall,
    convId === undefined ? null : { id: convId, toolUseId },
  );
  // The trace hook runs unconditionally, so the script is read here without an
  // early return; a transcript not read yet has no script (and is reported as
  // loading / failed below, never as an empty trace).
  let input: WorkflowInput | null = null;
  if (eventsResult.status === "ready") {
    const event = eventsResult.data;
    if (event?.kind === "tool-call") input = event.input as WorkflowInput;
  }

  const { graph, status } = useWorkflowTrace(input?.script ?? "", input?.args);

  if (convId === undefined) return { phase: "no-conversation" };
  switch (eventsResult.status) {
    case "loading":
      return { phase: "loading" };
    case "error":
      return {
        phase: "failed",
        error: eventsResult.error,
        retry: eventsResult.refetch,
      };
    case "ready": {
      const node = graph?.nodes.find((n) => n.id === nodeId);
      return { phase: "found", graph, status, node };
    }
  }
}

/**
 * The step's label, for the pane's `title.text`. The conversation id is the
 * ANCESTOR conversation pane's param, which the title hook receives in its
 * chained params.
 */
export function useWorkflowNodeTitle({
  convId,
  toolUseId,
  nodeId,
}: {
  convId?: string;
  toolUseId: string;
  nodeId: string;
}): string | undefined {
  const state = useWorkflowNode(convId, toolUseId, nodeId);
  return state.phase === "found" ? state.node?.label : undefined;
}
