/**
 * How fast the message being written is revealed. Tokens arrive in bursts (a
 * throttled push, a model that pauses and then dumps a sentence); revealing them
 * as they arrive reads as someone typing. The reveal instead drains what has
 * arrived at a steady rate, speeding up only as far as it must to never trail
 * the stream by more than `MAX_LAG_S`.
 */
export const BASE_CPS = 90;
export const MAX_LAG_S = 0.6;

export interface RevealStep {
  /** Characters of the text now revealed — always at a word boundary or the end. */
  revealed: number;
  /** Unspent reveal budget, in characters, carried into the next frame. */
  budget: number;
}

/**
 * One frame of the reveal: `dt` seconds have passed since the last one.
 * Reveals whole words only — a word cut in half is what a typist looks like.
 */
export function stepReveal(
  text: string,
  revealed: number,
  budget: number,
  dt: number,
): RevealStep {
  const total = text.length;
  if (revealed >= total) return { revealed: total, budget: 0 };
  const rate = Math.max(BASE_CPS, (total - revealed) / MAX_LAG_S);
  const available = budget + dt * rate;
  if (available < 1) return { revealed, budget: available };
  let next = Math.min(total, revealed + Math.floor(available));
  while (next < total && !/\s/.test(text[next]!)) next++;
  return { revealed: next, budget: Math.max(0, available - (next - revealed)) };
}
