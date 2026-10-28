/** A position, rank or version number as its digits — no thousands grouping (`1204`, not `1,204`). */
export function formatOrdinal(n: number): string {
  if (!Number.isFinite(n))
    throw new Error(`formatOrdinal: ${n} is not a position`);
  return String(Math.trunc(n));
}
