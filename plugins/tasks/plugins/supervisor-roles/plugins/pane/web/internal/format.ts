import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";
import { useRoleSessions } from "./reads";

/** A backlog task waiting this long reads as stale (the warning tone). */
export const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a task created at `created` has waited past {@link STALE_DAYS}. */
export function isStale(created: Date): boolean {
  return Date.now() - created.getTime() >= STALE_DAYS * DAY_MS;
}

/**
 * A role's sessions numbered from its first (#1), newest first — the window
 * reads the newest ones, so a session's number is its distance from the end
 * of the role's whole history. `null` until the sessions are known, or when
 * the window does not reach the first session.
 */
export function useSessionNumbers(
  roleId: string,
): ReadonlyMap<string, number> | null {
  const sessions = useRoleSessions(roleId);
  if (sessions.status !== "ready" || sessions.canGrow) return null;
  const n = sessions.data.length;
  return new Map(sessions.data.map((s, i) => [s.id, n - i]));
}

/** "Session 7", or "Live session" when its number is not known. */
export function sessionLabel(
  numbers: ReadonlyMap<string, number> | null,
  session: TaskTreeRow,
): string {
  const n = numbers?.get(session.id);
  return n === undefined ? "Live session" : `Session ${n}`;
}
