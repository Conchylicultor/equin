import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbExecutor } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  _attempts,
  _conversations,
  _tasks,
  getConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import { ConversationStatusSchema } from "@plugins/tasks/plugins/tasks-core/core";
import { STUCK_TURN_WAITING_FOR } from "@plugins/conversations/core";
import { mandateOf } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";

/** A task of the tree, and the agent working on it: its latest conversation
 * (`null` while no agent ran on it yet). */
export interface TreeAgent {
  taskId: string;
  title: string;
  conversation: {
    id: string;
    status: z.infer<typeof ConversationStatusSchema>;
    waitingFor: string | null;
    hibernated: boolean;
    unverified: boolean;
  } | null;
  /** The caller's own conversation. */
  self: boolean;
}

export type TreeAgents =
  /** The caller has no task, or its task no mandate. */
  | { kind: "no-tree" }
  | { kind: "found"; rootTaskId: string; agents: TreeAgent[] };

const Row = z.object({
  task_id: z.string(),
  title: z.string(),
  conversation_id: z.string().nullable(),
  status: ConversationStatusSchema.nullable(),
  waiting_for: z.string().nullable(),
  hibernated: z.boolean().nullable(),
  unverified: z.boolean().nullable(),
});

/**
 * Every task under `rootTaskId` (itself included) with its latest
 * conversation, in the order their agents started (tasks no agent ran on
 * last). Walks `folder_id` down by its index, as the tree digest does.
 */
export async function agentsUnder(
  exec: DbExecutor,
  rootTaskId: string,
  selfConversationId: string,
): Promise<TreeAgent[]> {
  const rows = await executeRows(exec, {
    label: "message tree agents",
    query: sql`WITH RECURSIVE sub(id) AS (
          SELECT ${rootTaskId}::text
          UNION
          SELECT c.id FROM ${_tasks} c JOIN sub ON c.folder_id = sub.id
        ),
        latest AS (
          SELECT DISTINCT ON (a.task_id)
                 a.task_id, c.id, c.status::text AS status, c.waiting_for,
                 c.hibernated_at IS NOT NULL AS hibernated,
                 c.status_unverified_since IS NOT NULL AS unverified,
                 c.created_at
            FROM sub
            JOIN ${_attempts} a ON a.task_id = sub.id
            JOIN ${_conversations} c ON c.attempt_id = a.id
           ORDER BY a.task_id, c.created_at DESC, c.id DESC
        )
        SELECT t.id AS task_id, t.title, l.id AS conversation_id, l.status,
               l.waiting_for, l.hibernated, l.unverified
          FROM sub
          JOIN ${_tasks} t ON t.id = sub.id
          LEFT JOIN latest l ON l.task_id = t.id
         ORDER BY l.created_at ASC NULLS LAST, t.id`,
    row: Row,
  });
  return rows.map((r) => ({
    taskId: r.task_id,
    title: r.title,
    conversation:
      r.conversation_id === null || r.status === null
        ? null
        : {
            id: r.conversation_id,
            status: r.status,
            waitingFor: r.waiting_for,
            hibernated: r.hibernated === true,
            unverified: r.unverified === true,
          },
    self: r.conversation_id === selfConversationId,
  }));
}

/** The agents of the caller's mandate tree — the whole tree, from the
 * mandate's root (the same tree `task_tree` shows). */
export async function treeAgents(conversationId: string): Promise<TreeAgents> {
  const conversation = await getConversation(conversationId);
  if (conversation === null) return { kind: "no-tree" };
  const mandate = await mandateOf(conversation.taskId);
  if (mandate.kind === "none") return { kind: "no-tree" };
  return {
    kind: "found",
    rootTaskId: mandate.rootTaskId,
    agents: await agentsUnder(db, mandate.rootTaskId, conversationId),
  };
}

/** How an agent stands, in words. */
export function standingOf(c: NonNullable<TreeAgent["conversation"]>): string {
  const words = [statusWords(c)];
  if (c.unverified) words.push("status unverified");
  return words.join(" · ");
}

function statusWords(c: NonNullable<TreeAgent["conversation"]>): string {
  switch (c.status) {
    case "starting":
      return "starting";
    case "working":
      return "working";
    case "waiting":
      if (c.waitingFor === STUCK_TURN_WAITING_FOR)
        return "stuck (alive, at rest, holding a turn it was handed but never started — its Claude Code looks wedged; a message only queues behind that turn)";
      if (c.waitingFor !== null) return "waiting on the user";
      return c.hibernated ? "idle (hibernated)" : "idle";
    case "gone":
      return "stopped";
    case "done":
      return "closed";
  }
}

/** `list_agents`' answer: one line per task an agent ran on. */
export function renderAgents(agents: readonly TreeAgent[]): string {
  const lines = agents.flatMap((a) =>
    a.conversation === null
      ? []
      : [
          `- ${a.taskId} "${a.title}" · ${a.conversation.id} · ${standingOf(a.conversation)}${a.self ? " · you" : ""}`,
        ],
  );
  const waiting = agents.filter((a) => a.conversation === null).length;
  if (lines.length === 0) return "No agent has run on a task of this tree yet.";
  const tail =
    waiting > 0
      ? `\n\n${waiting} task${waiting === 1 ? "" : "s"} no agent ran on yet (see \`task_tree\`).`
      : "";
  return lines.join("\n") + tail;
}
