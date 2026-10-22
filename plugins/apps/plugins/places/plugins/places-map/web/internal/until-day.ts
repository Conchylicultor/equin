/** "Ratings paused until Nov 1" — the date a budget downgrade lifts. */
export function untilDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
