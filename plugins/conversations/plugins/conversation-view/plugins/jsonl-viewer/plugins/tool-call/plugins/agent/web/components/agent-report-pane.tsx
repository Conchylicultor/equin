import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { SubagentPaneBody } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import { SubagentRefSchema } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { agentReportPane } from "../panes";

/**
 * Route ownership only. The `agent` plugin knows which sub-agent the URL
 * names (by its launching call, or by its own id) and which conversation it
 * hangs off; everything about the sub-agent
 * itself — its state, its write-up, its transcript — belongs to the `subagents`
 * plugin, which owns the two resources behind it.
 */
export function AgentReportPaneBody() {
  const params = agentReportPane.useParams();
  // Parsed, not cast: a hand-edited URL naming some other `by` is refused here
  // rather than subscribing to a key kind the server does not know.
  const subagent = SubagentRefSchema.safeParse(params);
  const convId = conversationPane.useEnclosing()?.params.convId;

  return (
    <PaneChrome pane={agentReportPane}>
      {convId === undefined ? (
        // A conversation-scoped satellite with no conversation above it: the
        // route was reached in a way this pane cannot serve. Say so rather than
        // subscribing to an empty conversation id and rendering "nothing yet".
        <Inset pad="lg">
          <Text as="div" variant="body" className="text-muted-foreground">
            This pane opens inside a conversation, and none is open here.
          </Text>
        </Inset>
      ) : !subagent.success ? (
        <Inset pad="lg">
          <Text as="div" variant="body" className="text-muted-foreground">
            This link does not name a sub-agent.
          </Text>
        </Inset>
      ) : (
        <SubagentPaneBody conversationId={convId} subagent={subagent.data} />
      )}
    </PaneChrome>
  );
}
