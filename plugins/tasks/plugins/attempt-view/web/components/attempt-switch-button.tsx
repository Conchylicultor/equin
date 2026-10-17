import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { attemptRows } from "@plugins/tasks/plugins/tasks-core/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { attemptPane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const splitscreenIcon = symbol("splitscreen");

export function AttemptSwitchButton() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const result = useLive(attemptRows);

  const { isOpen, toggle } = attemptPane.useToggle(
    { attemptId: conversation?.attemptId ?? "" },
    { action: "unwrap", side: "left" },
  );

  // Render a neutral button (no count chip) while the resource is still loading —
  // the variant and toggle are data-independent so the button is usable immediately.
  // A failed read gets the same neutral button, deliberately: the count is
  // decoration, the toggle still works, and the attempt pane it opens reads the
  // same resource and renders the failure with Retry.
  switch (result.status) {
    case "ready":
      break;
    case "loading":
    case "error":
      return (
        // eslint-disable-next-line icon-button/prefer-icon-button -- placeholder for the icon+count button below; a square IconButton would resize the toolbar when the count settles
        <Button
          variant={isOpen ? "secondary" : "ghost"}
          tooltip={isOpen ? "Close attempt view" : "Open attempt view"}
          aria-label={isOpen ? "Close attempt view" : "Open attempt view"}
          aria-pressed={isOpen}
          onClick={toggle}
        >
          <Icon icon={splitscreenIcon} />
        </Button>
      );
  }

  const attempt =
    result.data.find((a) => a.id === conversation?.attemptId) ?? null;
  const count = attempt?.conversations.length ?? 0;

  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      tooltip={isOpen ? "Close attempt view" : "Open attempt view"}
      aria-label={isOpen ? "Close attempt view" : "Open attempt view"}
      aria-pressed={isOpen}
      onClick={toggle}
      className="gap-xs"
    >
      <Icon icon={splitscreenIcon} />
      <Text as="span" variant="count">
        {count}
      </Text>
    </Button>
  );
}
