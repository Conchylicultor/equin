import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { WorktreeOpGantt } from "@plugins/debug/plugins/profiling/plugins/ops/web";
import { OP_KINDS, OP_KIND_IDS } from "@plugins/infra/plugins/worktree/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { RowView } from "@plugins/network/plugins/live/web";

// The empty state names every kind of op this Gantt can show. Read off the
// `OP_KINDS` declaration rather than written out, so a kind added there is named
// here too — the hand-kept list said "build, push, or check" long after `test`
// and `e2e` joined.
const OP_KIND_LIST = new Intl.ListFormat("en", {
  type: "disjunction",
}).format(OP_KIND_IDS.map((id) => OP_KINDS[id].label.toLowerCase()));

export function PushProfilingPaneBody() {
  const convId = conversationPane.useEnclosing()?.params.convId;
  const conversation = useConversationById(convId ?? null);

  if (convId === undefined) return null;

  return (
    <RowView
      row={conversation}
      subject="the conversation"
      missing={<Placeholder>This conversation no longer exists.</Placeholder>}
    >
      {(conv) => (
        <WorktreeOpGantt
          worktree={conv.attemptId}
          empty={
            <Text
              as="div"
              variant="body"
              className="p-lg text-muted-foreground"
            >
              No {OP_KIND_LIST} activity for this conversation.
            </Text>
          }
        />
      )}
    </RowView>
  );
}
