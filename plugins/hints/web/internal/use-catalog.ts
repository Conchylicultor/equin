import { useMemo } from "react";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { joinCatalog, type HintCatalogEntry } from "./catalog";
import { useHints, useTours } from "./registry";
import { useHintSeen } from "./seen";

/**
 * Every declared hint and tour joined with its seen row — the read a "Your
 * tips" tracker renders. Not known until the seen state is.
 */
export function useHintCatalog(): ResourceResult<readonly HintCatalogEntry[]> {
  const hints = useHints();
  const tours = useTours();
  const seen = useHintSeen();
  return useMemo(
    () => mapResource(seen, (rows) => joinCatalog(hints, tours, rows)),
    [hints, tours, seen],
  );
}
