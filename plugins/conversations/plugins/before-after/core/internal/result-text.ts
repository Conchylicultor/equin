import type { BeforeAfterColorScheme } from "./entity";

/** What a registered pair's tool result says about it. */
export interface RegisteredPairSummary {
  id: string;
  title: string;
  route: string | null;
  width: number;
  height: number;
  colorScheme: BeforeAfterColorScheme | null;
  beforeLabel: string;
  afterLabel: string;
  /** Anything the agent should know about the capture (a loader still up, an HTTP error). */
  notes: readonly string[];
}

/**
 * The text part of `register_before_after`'s result — the id to cite, what was
 * compared, then the two images follow. One spelling, read by the tool and by
 * a transcript that records a registration (the website demo's seed).
 */
export function registeredPairText(pair: RegisteredPairSummary): string {
  const what =
    pair.route === null
      ? `${pair.beforeLabel} vs ${pair.afterLabel}`
      : `${pair.route} — ${pair.beforeLabel} vs ${pair.afterLabel}, ${pair.width}×${pair.height} ${pair.colorScheme ?? ""}`.trim();
  return [
    `Registered before / after ${pair.id}: "${pair.title}" (${what}).`,
    `Cite ${pair.id} in your final message, next to what it shows — it renders as a chip that opens the comparison.`,
    ...pair.notes,
    `Before (${pair.beforeLabel}), then after (${pair.afterLabel}):`,
  ].join("\n");
}
