import type { BeforeAfterPair } from "../../core";

/** The pair `step` places away from `id` in `pairs`, wrapping at both ends. */
export function steppedPair(
  pairs: readonly BeforeAfterPair[],
  id: string,
  step: 1 | -1,
): BeforeAfterPair | undefined {
  const at = pairs.findIndex((p) => p.id === id);
  if (at === -1 || pairs.length === 0) return undefined;
  return pairs[(at + step + pairs.length) % pairs.length];
}
