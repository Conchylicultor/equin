/** The first line of EVERY guard denial. */
export const REFUSAL_HEADER = "BLOCKED BY A GUARD: this tool call did NOT run.";

const WHY = "\n\nWhy it was blocked:\n";

/** A denial: the what-did-not-happen banner, then the guard's reason. */
export function joinRefusal(banner: string, reason: string): string {
  return `${banner}${WHY}${reason}`;
}

/**
 * The guard's own reason out of a denial `joinRefusal` wrote — what a reader
 * needs, without the banner aimed at the agent. Undefined for any other text
 * (a hook that is not one of our guards).
 */
export function refusalReason(text: string): string | undefined {
  if (!text.startsWith(REFUSAL_HEADER)) return undefined;
  const at = text.indexOf(WHY);
  if (at < 0) return undefined;
  return text.slice(at + WHY.length).trim() || undefined;
}
