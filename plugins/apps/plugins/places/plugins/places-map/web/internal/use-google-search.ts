import { useMemo, useState } from "react";
import type { MapBounds } from "@plugins/map/core";
import {
  searchRung,
  type PlaceBounds,
  type PlaceSearchResult,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import type { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import { useMapsBudget } from "@plugins/integrations/plugins/google-maps/plugins/usage/web";
import { usePlaceSearch } from "@plugins/apps/plugins/places/plugins/places-core/web";
import type { GoogleHit } from "../components/google-result-card";
import { candidateHit, googleResultVisual } from "./google-result";
import { useDebouncedValue } from "./use-debounced-value";

/** How long typing must pause before Google is asked. */
const SEARCH_DEBOUNCE_MS = 300;
/** Google is asked from this many characters on: one letter matches the world. */
export const GOOGLE_MIN_CHARS = 2;
/**
 * The bias box is rounded to this many decimals (~100 m): a camera settling a
 * pixel further is the same question, so the same answer — never another call.
 */
const BIAS_DECIMALS = 3;

/** What the Google half of the search panel shows. */
export type GoogleSearchState =
  /** Too short to ask (or nothing typed). */
  | { kind: "idle" }
  /** Asked, nothing to show yet. */
  | { kind: "loading" }
  | {
      kind: "error";
      error: ResourceError<string>;
      refetch: () => Promise<void>;
    }
  | { kind: "not-configured" }
  | {
      kind: "answer";
      /** The ladder's rung that answered (`PlaceSearchResult`). */
      rung: "rich" | "basic" | "names";
      /** When the richer detail comes back; absent on `rich`. */
      resumesAt: string | undefined;
      /** In view first, then Google's order. */
      hits: readonly GoogleHit[];
      /** A newer question is being asked; these hits answer the previous one. */
      refreshing: boolean;
    };

const round = (n: number) => Number(n.toFixed(BIAS_DECIMALS));

/** The map's view as the search's bias box, rounded ({@link BIAS_DECIMALS}). */
export function biasOf(bounds: MapBounds): PlaceBounds {
  return {
    low: { lat: round(bounds.south), lng: round(bounds.west) },
    high: { lat: round(bounds.north), lng: round(bounds.east) },
  };
}

function hitsOf(
  answer: PlaceSearchResult & { kind: "rich" | "basic" | "names" },
  bounds: MapBounds,
  tags: readonly PlaceTag[],
): GoogleHit[] {
  if (answer.kind === "names") {
    return answer.suggestions.map((s) => ({
      placeId: s.placeId,
      name: s.primary,
      line: s.secondary,
      result: undefined,
      // An autocomplete name carries no types: the visual of a place no tag claims.
      visual: googleResultVisual([], tags),
      offMap: false,
    }));
  }
  const hits = answer.results.map((r) => candidateHit(r, bounds, tags));
  // Stable: Google's order within each half.
  return [...hits.filter((h) => !h.offMap), ...hits.filter((h) => h.offMap)];
}

/**
 * The Google half of the Places search: `text` debounced, asked once it is
 * {@link GOOGLE_MIN_CHARS} long, biased to the map's view (`bounds`, asked
 * again when the camera rests elsewhere), at the downgrade ladder's rung this
 * month's budget allows (`useMapsBudget`), in one session per `session`. While
 * a newer question is out, the previous answer stays (`refreshing`), so the
 * cards do not blink on every keystroke or pan; a question too short to ask
 * drops it.
 */
export function useGoogleSearch({
  text,
  bounds,
  session,
  tags,
}: {
  text: string;
  bounds: MapBounds | null;
  session: string;
  tags: readonly PlaceTag[];
}): GoogleSearchState {
  const q = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  const asking = q.length >= GOOGLE_MIN_CHARS;
  const bias = bounds === null ? null : biasOf(bounds);
  // The ladder's rung, from this month's live counts: the search is asked at
  // the richest detail the free allowance still covers.
  const budget = useMapsBudget();
  const rung =
    budget.status === "ready" ? searchRung(budget.data.withinBudget) : null;
  const search = usePlaceSearch(
    asking && bias !== null && rung !== null
      ? { q, bias, session, rung }
      : null,
  );
  // The last answer, held while the next one loads (the render-phase
  // "adjust state on prop change" pattern — no effect).
  const [held, setHeld] = useState<PlaceSearchResult | null>(null);
  if (!asking && held !== null) setHeld(null);
  if (asking && search.status === "ready" && search.data !== held)
    setHeld(search.data);

  return useMemo((): GoogleSearchState => {
    if (!asking) return { kind: "idle" };
    if (budget.status === "error")
      return { kind: "error", error: budget.error, refetch: budget.refetch };
    if (search.status === "error" && held === null)
      return { kind: "error", error: search.error, refetch: search.refetch };
    const answer = search.status === "ready" ? search.data : held;
    if (answer === null || bounds === null) return { kind: "loading" };
    if (answer.kind === "maps-not-configured")
      return { kind: "not-configured" };
    return {
      kind: "answer",
      rung: answer.kind,
      resumesAt: answer.kind === "rich" ? undefined : answer.resumesAt,
      hits: hitsOf(answer, bounds, tags),
      refreshing: search.status !== "ready",
    };
  }, [asking, budget, search, held, bounds, tags]);
}
