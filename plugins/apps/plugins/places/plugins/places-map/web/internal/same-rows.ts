import { useState } from "react";

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `rows`, keeping the identity of the last list it equalled item by item (the
 * same rows, in the same order): a recomputation that changed nothing hands
 * its consumer the list it already has, so a DataView under it derives
 * nothing again. O(rows) per call.
 */
export function useSameRows<T>(rows: readonly T[] | null): readonly T[] | null {
  const [held, setHeld] = useState(rows);
  if (rows === held) return held;
  if (rows !== null && held !== null && sameItems(rows, held)) return held;
  // The render-phase "adjust state on prop change" pattern — no effect.
  setHeld(rows);
  return rows;
}
