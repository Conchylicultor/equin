import type { ReactNode } from "react";
import { ReorderItemClaimContext } from "../internal/item-claim";

/**
 * Stands in for the list middleware's per-`renderItem` claim, so a test can
 * render `ReorderItemMiddleware` as an item of a hand-built area.
 */
export function ReorderItemClaim({ children }: { children: ReactNode }) {
  return (
    <ReorderItemClaimContext.Provider value={true}>
      {children}
    </ReorderItemClaimContext.Provider>
  );
}
