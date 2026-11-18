import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { listActiveConversations } from "@plugins/tasks/plugins/tasks-core/server";
import { sendSectionNotice } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/change-notice/server";
import { SUPERVISOR_ROLES_SECTION_ID } from "../../server";

const LEAD =
  "The list of supervisor roles you can file into was just changed by the user. This is for your information only — it is NOT a request to act: route work to these roles from now on, as you otherwise would.";

/**
 * The Supervisor roles section is rendered at each spawn of an agent's
 * process, so a role listed (or renamed, or removed) after an agent started
 * never reached it — it kept filing to the roles it saw. On a listing change,
 * every live agent the section speaks to (one whose mandate may file into a
 * backlog), or spoke to at its spawn, is sent it again through the same path
 * as a mandate change (`sendSectionNotice`).
 */
export const onListingChangedJob = defineJob({
  name: "supervisor-roles.listing-notice",
  description:
    "When the listed supervisor roles change (a listed role created, deleted, renamed or re-described; a role listed or unlisted), sends each live agent whose mandate may file into a backlog the Supervisor roles system-prompt section, rendered again, as an informational turn.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z.object({ roleId: z.string() }).passthrough(),
  run: async ({ event }) => {
    if (!event) return;
    const live = await listActiveConversations();
    await Promise.all(
      live.map((c) =>
        sendSectionNotice(c, {
          lead: LEAD,
          pick: (s) => s.id === SUPERVISOR_ROLES_SECTION_ID,
          reconnectMcp: false,
        }),
      ),
    );
  },
});
