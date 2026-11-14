/** The island's light: the clock's phase of the day. */
export type DayPhase = "day" | "dusk" | "night";

/** Where each phase begins, in local hours: dusk at dawn 5:30, day 7:30, dusk 17:00, night 20:00. */
const BOUNDS: readonly (readonly [number, DayPhase])[] = [
  [5.5, "dusk"],
  [7.5, "day"],
  [17, "dusk"],
  [20, "night"],
];

/**
 * The phase of the day at `d` (local time), and when the next one begins —
 * the instant a reader re-reads the clock (one timeout, never an interval).
 */
export function dayPhaseAt(d: Date): {
  readonly phase: DayPhase;
  readonly next: Date;
} {
  const h =
    d.getHours() +
    d.getMinutes() / 60 +
    d.getSeconds() / 3600 +
    d.getMilliseconds() / 3_600_000;
  let phase: DayPhase = "night";
  for (const [at, p] of BOUNDS) if (h >= at) phase = p;
  const nextH = BOUNDS.find(([at]) => at > h)?.[0] ?? BOUNDS[0]![0] + 24;
  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  // setHours, not adding milliseconds: a DST day is 23 or 25 hours long
  next.setHours(Math.floor(nextH), Math.round((nextH % 1) * 60), 0, 0);
  return { phase, next };
}

/** How the where-chip words each phase. */
export const DAY_PHASE_PHRASE: Readonly<Record<DayPhase, string>> = {
  day: "a bright afternoon",
  dusk: "golden hour",
  night: "a quiet night",
};
