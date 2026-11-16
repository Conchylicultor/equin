/**
 * The open-sidequests gate's decision, pure (`open-sidequests-gate.ts` reads
 * the rows and owners): which waiting sidequests still block an exit, and the
 * refusal that lists them.
 */

import type { TaskOwnership } from "./task-ownership";

/** A candidate as the gate weighs it: a waiting sidequest the caller's task
 * filed, and its current owner (`null`: gone since the read). */
export interface SidequestCandidate {
  id: string;
  title: string;
  owner: TaskOwnership | null;
}

/** The candidates that still block `callerTask`'s exit: those its task owns as
 * their filer. */
export function blockingSidequests(
  candidates: readonly SidequestCandidate[],
  callerTask: string,
): SidequestCandidate[] {
  return candidates.filter(
    (c) => c.owner?.kind === "filer" && c.owner.taskId === callerTask,
  );
}

/** The refusal for `blocking` (non-empty); `more` = whether the read was cut
 * at its limit, so more may wait than listed. */
export function renderOpenSidequests(
  blocking: readonly SidequestCandidate[],
  more: boolean,
): string {
  const lines = blocking.map((c) => `- ${c.id} — ${c.title}`);
  return `You filed ${blocking.length === 1 ? "a sidequest that is" : "sidequests that are"} still waiting${more ? " (the first ones listed)" : ""}:

${lines.join("\n")}${more ? "\n- …and more" : ""}

Resolve each before closing:
- Drop it (\`drop_task\`) if it is not worth doing — ask yourself what it actually gains, and whether anyone would miss it.
- Or hand it to a supervisor (\`edit_task\` with \`supervisor: "<role id>"\`, from your system prompt's Supervisor roles), passing a \`description\` that adds whatever you learned since filing it.`;
}
