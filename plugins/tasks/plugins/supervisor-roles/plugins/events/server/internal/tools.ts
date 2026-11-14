import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { granted } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { supervisorRole } from "@plugins/tasks/plugins/supervisor-roles/core";
import { roleOfConversation } from "@plugins/tasks/plugins/supervisor-roles/server";
import {
  MESSAGES_KEPT_PER_ROLE,
  eventMessageIdKind,
  renderEventLine,
} from "../../core";
import { _supervisorEventMessages } from "./tables";
import { streamLabel } from "./streams";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/**
 * Every line of one of the caller's role's event messages — the message text
 * shows the most frequent ones and sums the rest in a `+N more` line.
 */
export const readEventMessageTool = Mcp.tool({
  name: "read_event_message",
  when: granted(supervisorRole),
  description: `Read every line of an event message your supervisor role received (\`sevmsg-…\`, named at the foot of a message whose lines did not all fit): each event's stream, count, kind, title and ref (a report id — read the whole report from there). Only your own role's messages; the last ${MESSAGES_KEPT_PER_ROLE} are kept.`,
  inputSchema: {
    message_id: z.string().min(1).describe("The message id (sevmsg-…)."),
  },
  async handler(input, { conversationId }) {
    const role = await roleOfConversation(conversationId);
    if (role === null)
      throw new Error("This conversation is not a supervisor role's session.");
    const messageId = input.message_id.trim();
    if (!eventMessageIdKind.is(messageId))
      return text(`"${messageId}" is not an event message id (sevmsg-…).`);
    const m = _supervisorEventMessages;
    const [row] = await db
      .select()
      .from(m)
      .where(and(eq(m.id, messageId), eq(m.roleId, role.roleId)));
    if (!row)
      return text(
        `No event message "${input.message_id}" for your role (only the last ${MESSAGES_KEPT_PER_ROLE} are kept).`,
      );
    const head = `${row.id} · ${row.events} events · ${row.lines.length} lines · sent ${row.sentAt.toISOString()} (${row.outcome})`;
    const byStream = new Map<string, string[]>();
    for (const l of row.lines) {
      const label = streamLabel(l.streamId);
      byStream.set(label, [
        ...(byStream.get(label) ?? []),
        `- ${renderEventLine(l)}`,
      ]);
    }
    return text(
      [
        head,
        ...[...byStream].flatMap(([s, ls]) => ["", `## ${s}`, ...ls]),
      ].join("\n"),
    );
  },
});
