import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  ClaudeCliError,
  runClaudePrint,
} from "@plugins/infra/plugins/claude-cli/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { _supervisorRoles, getSupervisorRole } from "../../server";
import {
  buildIconPrompt,
  ICON_SYSTEM_PROMPT,
  parseIconAnswer,
} from "./icon-answer";

/**
 * Picks a role's icon with Haiku from its name and description, on
 * `supervisorRoles.iconStale` (created, or renamed / re-described while its
 * icon is Haiku's). Keyed on the role and settled, so a burst of inline edits
 * costs one call. The write is guarded on the role still being what was
 * shown to the model and its icon still not a person's — an edit or a pick
 * that landed meanwhile wins (an edit brings its own run).
 */
export const supervisorRoleIconJob = defineJob({
  name: "supervisor-roles.icon",
  description:
    "Asks Claude Haiku for a Material Symbols icon for a supervisor role from its name and description.",
  // seconds: one Haiku call bounded by its own 30 s timeout.
  hold: "seconds",
  input: z.object({ roleId: z.string() }),
  event: z.object({ roleId: z.string() }).passthrough(),
  dedup: {
    key: ({ roleId }) => roleId,
    settle: { quietMs: 5_000, maxWaitMs: 60_000 },
  },
  serial: true,
  maxAttempts: 2,
  run: async ({ input: { roleId } }) => {
    const role = await getSupervisorRole(roleId);
    if (!role || role.iconByUser) return;
    let out: string;
    try {
      out = await runClaudePrint({
        tier: "haiku",
        prompt: buildIconPrompt(role),
        system: ICON_SYSTEM_PROMPT,
        timeoutMs: 30_000,
        source: {
          name: "supervisor-role-icon",
          context: { roleId },
          correlationId: roleId,
        },
      });
    } catch (err) {
      // A failed model call is filed as a report by claude-cli; the role
      // keeps the icon it has.
      if (err instanceof ClaudeCliError) return;
      throw err;
    }
    const answer = parseIconAnswer(out);
    if (!answer.ok) {
      console.warn(
        `[supervisor-roles] icon for ${roleId} rejected: ${answer.reason}`,
      );
      return;
    }
    await db
      .update(_supervisorRoles)
      .set({ icon: answer.icon })
      .where(
        and(
          eq(_supervisorRoles.id, role.id),
          eq(_supervisorRoles.iconByUser, false),
          eq(_supervisorRoles.name, role.name),
          eq(_supervisorRoles.description, role.description),
        ),
      );
  },
});
