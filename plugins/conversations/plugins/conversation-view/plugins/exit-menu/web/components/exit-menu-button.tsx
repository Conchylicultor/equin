import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import type { PromptEditorActionProps } from "@plugins/primitives/plugins/prompt-editor/web";
import { ExitMenu } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const logoutIcon = symbol("logout");

export function ExitMenuButton(_: PromptEditorActionProps) {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);

  if (!conversation) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            aspect="icon"
            aria-label="Close options"
            tooltip="Close options"
          />
        }
      >
        <Icon icon={logoutIcon} className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <ExitMenu.Item.Render>
          {(item) => <item.component conversation={conversation} />}
        </ExitMenu.Item.Render>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
