import type { SupervisorRole } from "../../core";

/** What the Supervisor roles section shows of a role (`renderSupervisorRoles`). */
type ListedFace = Pick<SupervisorRole, "listed" | "name" | "description">;

/**
 * Whether a role's change (`null`: absent — before its create, after its
 * delete) changes what the Supervisor roles section lists: it enters or
 * leaves the list, or a listed role's name or description changes. A
 * prompt, icon or section edit does not.
 */
export function listingChanged(
  before: ListedFace | null,
  after: ListedFace | null,
): boolean {
  const wasListed = before?.listed === true;
  const isListed = after?.listed === true;
  if (wasListed !== isListed) return true;
  if (!isListed || !before || !after) return false;
  return (
    before.name !== after.name ||
    before.description.trim() !== after.description.trim()
  );
}
