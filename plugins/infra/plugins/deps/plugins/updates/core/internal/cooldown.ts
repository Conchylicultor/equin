const DAY_MS = 86_400_000;

/**
 * When a release published at `published` (ISO instant) is past a `days`-day
 * cooldown measured the day-granular way the uv and cargo updaters measure it
 * (adopted once `published` is at or before the start of today, UTC, minus
 * `days`): the start of the first UTC day that far from it, as an ISO instant.
 */
export function cooldownEnd(published: string, days: number): string {
  const t = Date.parse(published);
  if (Number.isNaN(t)) throw new Error(`not an instant: ${published}`);
  return new Date(
    Math.ceil((t + days * DAY_MS) / DAY_MS) * DAY_MS,
  ).toISOString();
}
