import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { searchCountLine } from "../../core";

/** One candidate as the agent reads it: the facts it picks by, nothing it cannot use. */
export interface CandidateLine {
  placeId: string;
  name: string;
  type?: string;
  address?: string;
  rating?: string;
  price?: string;
  status?: string;
  hours?: readonly string[];
}

const PRICE = ["free", "€", "€€", "€€€", "€€€€"] as const;

export function candidateLine(c: PlaceCandidate): CandidateLine {
  return {
    placeId: c.placeId,
    name: c.name,
    ...(c.category === undefined ? {} : { type: c.category }),
    ...(c.address === undefined ? {} : { address: c.address }),
    ...(c.rating === undefined
      ? {}
      : {
          rating: `${c.rating.toFixed(1)}★${c.ratingCount === undefined ? "" : ` from ${c.ratingCount} reviews`}`,
        }),
    ...(c.priceLevel === undefined ? {} : { price: PRICE[c.priceLevel] }),
    ...(c.businessStatus === undefined || c.businessStatus === "OPERATIONAL"
      ? {}
      : { status: c.businessStatus }),
    ...(c.hours === undefined ? {} : { hours: c.hours.weekdayDescriptions }),
  };
}

/** A search's answer to the agent: the hits as JSON, and what the rung left out. */
export function searchAnswer(
  results: readonly PlaceCandidate[],
  rung: "rich" | "basic",
): string {
  const note =
    rung === "basic"
      ? "This month's free Google quota for ratings is used: these results have no rating, price or hours. Say so in your answer.\n"
      : "";
  const head = `${note}${searchCountLine(results.length)}`;
  if (results.length === 0) return head;
  return `${head}\n${JSON.stringify(results.map(candidateLine), null, 1)}`;
}
