import { implement } from "@plugins/infra/plugins/endpoints/server";
import { touchConversationViewed } from "@plugins/tasks/plugins/tasks-core/server";
import { markViewed } from "../../shared/endpoints";

// The user opened the conversation: stamp lastViewedAt (resets the idle timer).
// Resuming a hibernated one is a separate, desktop-only endpoint
// (`resumeHibernated`, machine/), which the client calls only when the row says
// it is hibernated.
export const handleViewed = implement(markViewed, async ({ params }) => {
  await touchConversationViewed(params.id);
  return { ok: true as const };
});
