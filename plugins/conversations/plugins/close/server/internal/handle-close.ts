import { markConversationClosed } from "@plugins/tasks/plugins/tasks-core/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { closeConversation } from "@plugins/conversations/core";
import { CloseTeardown } from "./teardown";

// A close, on every host: the conversation is done, then every contributed
// teardown runs before the request returns — on the desktop that stops the
// agent (`machine/`), so a closed conversation's agent is never still editing
// after the user's close came back. A host running no agent contributes none.
export const handleClose = implement(closeConversation, async ({ params }) => {
  await markConversationClosed(params.id);
  for (const teardown of CloseTeardown.getContributions()) {
    await teardown.stop(params.id);
  }
});
