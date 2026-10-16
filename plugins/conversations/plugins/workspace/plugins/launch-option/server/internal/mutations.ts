import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import {
  DEFAULT_WORKSPACE,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import { tasksWorkspace } from "./tables";

/** The workspace the task's next attempt runs in — the worktree when unset. */
export async function getTaskWorkspace(taskId: string): Promise<WorkspaceSpec> {
  const row = await tasksWorkspace.get(taskId);
  return row ? row.spec : DEFAULT_WORKSPACE;
}

/**
 * Parses `spec` through its kind (a scratch profile's input schema fills in its
 * defaults), refusing one a task cannot launch in — an unknown profile, or one
 * whose input has no defaults — as a 400.
 */
export function parseTaskWorkspace(spec: WorkspaceSpec): WorkspaceSpec {
  try {
    return Workspace.get(spec.kind).parseSpec(spec);
  } catch (err) {
    throw new HttpError(
      400,
      `Cannot launch a task in this workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Upsert the parsed spec; the worktree (the default) or `null` deletes the row.
export async function setTaskWorkspace(
  taskId: string,
  spec: WorkspaceSpec | null,
): Promise<void> {
  if (spec && spec.kind !== DEFAULT_WORKSPACE.kind) {
    await tasksWorkspace.upsert(taskId, { spec: parseTaskWorkspace(spec) });
  } else {
    await tasksWorkspace.delete(taskId);
  }
}
