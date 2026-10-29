import { useCallback, useMemo } from "react";
import { useLive, useLiveMutation } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  hintsSeen,
  markHintSeenEndpoint,
  resetHintsEndpoint,
  type HintOutcome,
  type HintSeen,
} from "../../core";
import { forgetAnswered } from "./engine-store";

/**
 * The seen rows by hint id — a resource result, so "not known yet" stays a
 * state (`loading` / `error`) and never reads as "nothing seen", which would
 * flash every tip on every reload.
 */
export function useHintSeen(): ResourceResult<ReadonlyMap<string, HintSeen>> {
  const result = useLive(hintsSeen);
  return useMemo(
    () =>
      mapResource(result, (rows) => new Map(rows.map((r) => [r.hintId, r]))),
    [result],
  );
}

/**
 * Records a hint or tour as seen (null outcome: a tour that just started). A
 * predicted write: the row reads seen from the call.
 */
export function useMarkHintSeen(): (
  id: string,
  outcome: HintOutcome | null,
) => void {
  const mark = useLiveMutation(markHintSeenEndpoint);
  return useCallback(
    (id, outcome) => {
      mark.mutate({ body: { id, outcome } });
    },
    [mark],
  );
}

/**
 * Forgets the seen rows of `ids` (the help menu's "Show tips again" passes
 * every declared hint's id), so each shows again at its next moment. A
 * predicted write: the rows read gone at once; `onReset` runs once the server
 * has accepted it.
 */
export function useResetHints(
  onReset?: () => void,
): (ids: readonly string[]) => void {
  const reset = useLiveMutation(resetHintsEndpoint, {
    onSuccess: () => onReset?.(),
  });
  return useCallback(
    (ids) => {
      forgetAnswered(ids);
      reset.mutate({ body: { ids: [...ids] } });
    },
    [reset],
  );
}
