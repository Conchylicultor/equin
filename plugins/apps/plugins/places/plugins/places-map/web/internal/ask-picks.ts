import { useMemo } from "react";
import type { MapBounds } from "@plugins/map/core";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { useLatestResult } from "@plugins/conversations/plugins/agent-thread/web";
import type { PlaceTag } from "@plugins/apps/plugins/places/plugins/places-core/core";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  askCandidates,
  placesPicks,
  type PlacesPicks,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import type { GoogleHit } from "../components/google-result-card";
import { candidateHit } from "./google-result";

/** One of Sonnet's picks, ready for its card and its pin. */
export interface AskPick {
  /** 1-based rank in the answer (best first) — the card's and the pin's number. */
  n: number;
  why: string;
  hit: GoogleHit;
}

/**
 * A picks payload over the run's candidates. Every picked id is one the run's
 * searches returned (the tool refuses any other), so a pick with no candidate
 * means the candidates row has not caught up yet — it is left out until it
 * has, rather than drawn without a place behind it.
 */
export function picksOf(
  payload: PlacesPicks,
  candidates: Readonly<Record<string, PlaceCandidate>>,
  bounds: MapBounds | null,
  tags: readonly PlaceTag[],
): AskPick[] {
  return payload.picks.flatMap((p, i) => {
    const c = candidates[p.googlePlaceId];
    return c === undefined
      ? []
      : [{ n: i + 1, why: p.why, hit: candidateHit(c, bounds, tags) }];
  });
}

const NO_CANDIDATES: Readonly<Record<string, PlaceCandidate>> = {};

/** A run's Google candidates (`askCandidates`): none before its first search (no row yet). */
export function useAskCandidates(
  conversationId: string | null,
): ResourceResult<Readonly<Record<string, PlaceCandidate>>> {
  const row = useLiveRow(askCandidates, conversationId);
  return useMemo(
    () => mapRow(row, (r) => (r === null ? NO_CANDIDATES : r.candidates)),
    [row],
  );
}

/**
 * The run's newest picks, for the map: empty while there is no run, nothing
 * picked yet, or either read is still loading — pins are proposals, and none
 * is better than a wrong one.
 */
export function useLatestAskPicks(
  conversationId: string | null,
  bounds: MapBounds | null,
  tags: readonly PlaceTag[],
): readonly AskPick[] {
  const latest = useLatestResult(conversationId, placesPicks);
  const candidates = useAskCandidates(conversationId);
  return useMemo(
    () =>
      latest.status === "ready" &&
      latest.data !== null &&
      candidates.status === "ready"
        ? picksOf(latest.data.payload, candidates.data, bounds, tags)
        : [],
    [latest, candidates, bounds, tags],
  );
}
