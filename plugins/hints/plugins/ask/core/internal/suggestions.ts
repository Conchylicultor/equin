/** Shown on every open: the questions a newcomer asks first. */
export const ALWAYS_SUGGESTIONS = [
  "What can I do on this page?",
  "What's a good first thing to try?",
] as const;

/** One of these joins them, picked at random on each open. */
export const ROTATING_SUGGESTIONS = [
  "How do I find something I made earlier?",
  "Where is my data kept, and is it backed up?",
  "What's new?",
] as const;

/**
 * The suggested questions of an empty card: both of
 * {@link ALWAYS_SUGGESTIONS}, then one of {@link ROTATING_SUGGESTIONS}.
 * `random` is a `[0, 1)` source (`Math.random`), injected so a test can pick.
 */
export function pickSuggestions(random: () => number): string[] {
  const r = random();
  if (!(r >= 0 && r < 1)) {
    throw new Error(
      `pickSuggestions: random() gave ${r}, not a number in [0, 1)`,
    );
  }
  const rotating =
    ROTATING_SUGGESTIONS[Math.floor(r * ROTATING_SUGGESTIONS.length)]!;
  return [...ALWAYS_SUGGESTIONS, rotating];
}
