/** One report of an incident that would ring the bell alone. */
export interface IncidentMember {
  /** Its row was created by this occurrence: never seen in this worktree. */
  isNew: boolean;
}

/**
 * Which of an incident's ringing reports (most significant first) rings its one
 * notification: the first NEW one when there is one — a problem never seen
 * before is news, and keyed by its own fresh report it always alerts unread,
 * whatever the lead's re-alert window says — otherwise the lead. `fresh` counts
 * the new ones, so the bell can say there are more. Null when none rings.
 */
export function pickIncidentBell(
  members: readonly IncidentMember[],
): { index: number; fresh: number } | null {
  if (members.length === 0) return null;
  const fresh = members.filter((m) => m.isNew).length;
  const firstNew = members.findIndex((m) => m.isNew);
  return { index: firstNew === -1 ? 0 : firstNew, fresh };
}
