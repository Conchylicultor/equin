import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  workspaceAllows,
  type WorkspaceKindState,
} from "@plugins/conversations/plugins/workspace/core";
import { Conversation } from "../slots";

export function ActionBarView({
  workspace,
}: {
  /** The conversation's workspace, which gates each action's `requires`. */
  workspace: WorkspaceKindState;
}) {
  return (
    <Stack direction="row" gap="xs" align="center" className="w-full">
      <Conversation.ActionBar.Render>
        {(item) =>
          workspaceAllows(workspace, item.requires) ? <item.component /> : null
        }
      </Conversation.ActionBar.Render>
    </Stack>
  );
}
