import { useMemo } from "react";
import type { MapBounds } from "@plugins/map/core";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useThreadTurns } from "@plugins/conversations/plugins/agent-thread/web";
import type { PlaceTag } from "@plugins/apps/plugins/places/plugins/places-core/core";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  askCandidates,
  placesPicks,
  type PickSource,
  type PlacesPicks,
} from "@plugins/apps/plugins/places/plugins/ask/core";
import type { GoogleHit } from "../components/google-result-card";
import { candidateHit } from "./google-result";

/** What Sonnet said about one pick — its card's and its detail card's words. */
export interface AskPickNote {
  /** 1-based rank in the answer (best first) — the card's and the pin's number. */
  n: number;
  /** One line of the facts it checked. */
  why: string;
  /** What makes it special, from its sources; absent on a pick stored before it existed. */
  about: string | undefined;
  /** Where it read about it. */
  sources: readonly PickSource[];
}

/** One of Sonnet's picks, ready for its card and its pin. */
export interface AskPick extends AskPickNote {
  hit: GoogleHit;
}

/** One accepted picks result of a run, in thread order. */
export interface AskResult {
  /** The call's id — what tells one result from another across turns. */
  toolUseId: string;
  payload: PlacesPicks;
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
      : [
          {
            n: i + 1,
            why: p.why,
            about: p.about,
            sources: p.sources ?? [],
            hit: candidateHit(c, bounds, tags),
          },
        ];
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

const RESULTS = [placesPicks];

/**
 * Every picks result the run delivered, in thread order — the last one is the
 * CURRENT result (a follow-up turn without picks leaves it current). Empty
 * while there is no run (a `null` id) or no such conversation.
 */
export function useAskResults(
  conversationId: string | null,
): ResourceResult<readonly AskResult[]> {
  const turns = useThreadTurns(conversationId, RESULTS);
  return useMemo(
    () =>
      mapResource(turns, (ts) =>
        (ts ?? []).flatMap((t) =>
          t.results.flatMap((r) =>
            r.kind === "accepted"
              ? [{ toolUseId: r.toolUseId, payload: r.payload }]
              : [],
          ),
        ),
      ),
    [turns],
  );
}

/**
 * The picks the map shows: the current result's, then those of every earlier
 * result the thread has expanded (`expanded`, by call id). A place picked
 * twice is drawn once, as its newest pick. Empty while either read is still
 * loading — pins are proposals, and none is better than a wrong one.
 */
export function mapPicksOf(
  results: readonly AskResult[],
  expanded: ReadonlySet<string>,
  candidates: Readonly<Record<string, PlaceCandidate>>,
  bounds: MapBounds | null,
  tags: readonly PlaceTag[],
): AskPick[] {
  const shown = new Set<string>();
  const out: AskPick[] = [];
  // Newest first, so a place's newest pick claims its pin.
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i]!;
    const current = i === results.length - 1;
    if (!current && !expanded.has(result.toolUseId)) continue;
    for (const p of picksOf(result.payload, candidates, bounds, tags)) {
      if (shown.has(p.hit.placeId)) continue;
      shown.add(p.hit.placeId);
      out.push(p);
    }
  }
  return out;
}

/** {@link mapPicksOf} over the run's live reads. */
export function useAskMapPicks(
  conversationId: string | null,
  expanded: ReadonlySet<string>,
  bounds: MapBounds | null,
  tags: readonly PlaceTag[],
): readonly AskPick[] {
  const results = useAskResults(conversationId);
  const candidates = useAskCandidates(conversationId);
  return useMemo(
    () =>
      results.status === "ready" && candidates.status === "ready"
        ? mapPicksOf(results.data, expanded, candidates.data, bounds, tags)
        : [],
    [results, candidates, expanded, bounds, tags],
  );
}
