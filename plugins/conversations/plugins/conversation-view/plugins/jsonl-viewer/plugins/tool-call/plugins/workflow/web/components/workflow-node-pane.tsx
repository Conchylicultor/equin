import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { ConversationFileLinks } from "@plugins/conversations/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  Badge,
  formatStatusLabel,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { modelDisplayLabel } from "@plugins/conversations/plugins/model-provider/core";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { workflowNodePane } from "../panes";
import { useWorkflowNode } from "../internal/use-workflow-node";

export function WorkflowNodePaneBody() {
  const convId = conversationPane.useRouteEntry()?.params.convId;
  // The step's prompt names files in its conversation's worktree.
  return (
    <ConversationFileLinks conversationId={convId ?? null}>
      <WorkflowNodePaneContent convId={convId} />
    </ConversationFileLinks>
  );
}

function WorkflowNodePaneContent({ convId }: { convId: string | undefined }) {
  const { toolUseId, nodeId } = workflowNodePane.useParams();
  const state = useWorkflowNode(convId, toolUseId, nodeId);

  if (state.phase === "loading") {
    return (
      <PaneChrome pane={workflowNodePane}>
        <Loading />
      </PaneChrome>
    );
  }
  if (state.phase === "failed") {
    return (
      <PaneChrome pane={workflowNodePane}>
        <ResourceErrorInline
          variant="block"
          subject="the transcript"
          error={state.error}
          refetch={state.retry}
        />
      </PaneChrome>
    );
  }

  // A step belongs to a conversation's transcript: opened with no
  // conversation in the route, the pane says so.
  if (state.phase === "no-conversation") {
    return (
      <PaneChrome pane={workflowNodePane}>
        <Text as="div" variant="body" className="text-muted-foreground">
          Open this step from its conversation.
        </Text>
      </PaneChrome>
    );
  }

  const { graph, status, node } = state;

  return (
    <PaneChrome pane={workflowNodePane}>
      <Stack gap="md" className="p-lg">
        {!node ? (
          <Text as="div" variant="body" className="text-muted-foreground">
            {status === "tracing" ? "Parsing workflow…" : "Step not found."}
          </Text>
        ) : (
          <>
            <Cluster gap="xs" className="text-2xs">
              {node.phase && <Badge variant="muted">{node.phase}</Badge>}
              {node.model && (
                <Badge variant="muted" className="font-mono">
                  {modelDisplayLabel(node.model)}
                </Badge>
              )}
              {node.agentType && (
                <Badge variant="muted">
                  {formatStatusLabel(node.agentType)}
                </Badge>
              )}
              {node.hasSchema && <Badge variant="muted">Schema</Badge>}
            </Cluster>
            {node.deps.length > 0 && (
              <div className="text-2xs text-muted-foreground">
                Depends on:{" "}
                {node.deps
                  .map((d) => graph?.nodes.find((n) => n.id === d)?.label ?? d)
                  .join(", ")}
              </div>
            )}
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <Markdown>{node.prompt}</Markdown>
            </div>
          </>
        )}
      </Stack>
    </PaneChrome>
  );
}
