import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { WorkspaceSpecSchema } from "../../core";
import type { WorkspaceAt } from "./registry";

// Raw SQL over the `attempts` / `conversations` tables rather than tasks-core's
// table handles: tasks-core's field record imports this plugin's `core` (the
// spec it stores), so importing tasks-core back from here would be a cycle.
// The two columns read are this plugin's own concern — the attempt's
// workspace path and spec.
const WorkspaceRowSchema = z.object({
  attemptId: z.string(),
  path: z.string(),
  spec: WorkspaceSpecSchema,
});

/** The workspace an attempt runs in. Throws for an unknown attempt. */
export async function workspaceOfAttempt(
  attemptId: string,
): Promise<WorkspaceAt> {
  const [row] = await executeRows(db, {
    query: sql`
      SELECT id AS "attemptId", worktree_path AS path, workspace AS spec
      FROM attempts
      WHERE id = ${attemptId}
    `,
    row: WorkspaceRowSchema,
    label: "workspace of attempt",
  });
  if (!row) throw new Error(`Unknown attempt "${attemptId}"`);
  return row;
}

/**
 * The workspace a conversation runs in — its attempt's. For an MCP tool that
 * resolves files in the agent's directory. Throws for an unknown conversation.
 */
export async function workspaceOfConversation(
  conversationId: string,
): Promise<WorkspaceAt> {
  const found = await findWorkspaceOfConversation(conversationId);
  if (!found.found) {
    throw new Error(`Unknown conversation "${conversationId}"`);
  }
  return found.workspace;
}

/**
 * {@link workspaceOfConversation} for a caller to whom an unknown
 * conversation is an answer, not a bug (the MCP scope: a session this backend
 * holds no row for was never launched as a scratch one).
 */
export async function findWorkspaceOfConversation(
  conversationId: string,
): Promise<{ found: true; workspace: WorkspaceAt } | { found: false }> {
  const [row] = await executeRows(db, {
    query: sql`
      SELECT a.id AS "attemptId", a.worktree_path AS path, a.workspace AS spec
      FROM conversations c
      JOIN attempts a ON a.id = c.attempt_id
      WHERE c.id = ${conversationId}
    `,
    row: WorkspaceRowSchema,
    label: "workspace of conversation",
  });
  return row ? { found: true, workspace: row } : { found: false };
}
