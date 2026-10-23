import { useCallback, useMemo } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
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

/** Records a hint or tour as seen (null outcome: a tour that just started). */
export function useMarkHintSeen(): (
  id: string,
  outcome: HintOutcome | null,
) => void {
  const fetchEndpoint = useFetchEndpoint();
  return useCallback(
    (id, outcome) => {
      // eslint-disable-next-line endpoints/no-void-fetch-endpoint -- fire-and-forget from a click or a tour transition: the UI never waits on it (the session's answered set already hides the hint), and a failure surfaces as an unhandled rejection the reports plugin files — the only cost is the tip showing again on a later load.
      void fetchEndpoint(markHintSeenEndpoint, {}, { body: { id, outcome } });
    },
    [fetchEndpoint],
  );
}

/**
 * Forgets the seen rows of `ids` (the help menu's "Show tips again" passes
 * every declared hint's id), so each shows again at its next moment.
 */
export function useResetHints(): (ids: readonly string[]) => Promise<void> {
  const fetchEndpoint = useFetchEndpoint();
  return useCallback(
    async (ids) => {
      await fetchEndpoint(resetHintsEndpoint, {}, { body: { ids: [...ids] } });
      forgetAnswered(ids);
    },
    [fetchEndpoint],
  );
}
