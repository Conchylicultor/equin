import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchRow } from "@plugins/network/plugins/live/core";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * Close a conversation: stop its agent and mark it done. Predicted — every
 * live read of the conversation shows it closed at once (it leaves the active
 * list, the exit controls flip to Restore); the task's derived status and the
 * gone list's entry arrive by push.
 */
export const exitConversation = defineEndpoint({
  route: "POST /api/conversations/:id/exit",
  needsMachine: { feature: "Closing an agent's conversation" },
  effect: (on) =>
    patchRow(
      on,
      conversationsEntityRef,
      ({ params }) => params.id,
      () => ({
        set: { status: "done", workingOn: null },
        approx: { endedAt: new Date() },
      }),
    ),
});
