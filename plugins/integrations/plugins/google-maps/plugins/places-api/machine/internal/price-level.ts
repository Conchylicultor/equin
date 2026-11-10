const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/**
 * Google's `priceLevel` enum as 0 (free) … 4 (very expensive). Absent, or
 * Google's "unspecified" default, is no price; an enum value Google added since
 * throws rather than drawing a made-up price.
 */
export function priceLevel(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "PRICE_LEVEL_UNSPECIFIED") return undefined;
  const level = PRICE_LEVELS[raw];
  if (level === undefined) throw new Error(`Unknown Places priceLevel ${raw}`);
  return level;
}
