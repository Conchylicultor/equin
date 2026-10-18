import { useCallback } from "react";
import { useCompanionLookup } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "../slots";

/**
 * The `onOrphanType` of a DataView's view sources: an authored row whose view
 * type has no renderer throws when the repo provides one this bundle lacks
 * (view renderers are keyed companions of the View slot), so the view is not
 * silently dropped from the switcher. A type nothing provides stays a skip.
 */
export function useOrphanViewTypeGuard(
  contributions: readonly object[],
): (type: string) => void {
  const lookup = useCompanionLookup(DataViewSlots.View, contributions);
  return useCallback(
    (type: string) => {
      lookup([type]);
    },
    [lookup],
  );
}
