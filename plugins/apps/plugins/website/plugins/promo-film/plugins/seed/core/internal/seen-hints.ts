/**
 * The onboarding tips and tours the film's user has already met — a returning
 * user, not a first launch: none of them pops up mid-shot. Marked through the
 * hints engine's own write (`markHintSeenEndpoint`, what a tip's "Got it"
 * calls) after the seed. Ids as their owners declare them (`defineHint` /
 * `defineTour`); the tour is "completed", every tip "dismissed".
 */
export const FILM_SEEN_HINTS: readonly {
  id: string;
  outcome: "completed" | "dismissed";
}[] = [
  { id: "home.tour", outcome: "completed" },
  { id: "prototypes.variants", outcome: "dismissed" },
  { id: "prototype.open-chip", outcome: "dismissed" },
  { id: "open-app.try-it", outcome: "dismissed" },
  { id: "push-and-exit.push-and-exit", outcome: "dismissed" },
  { id: "push-and-exit.exit", outcome: "dismissed" },
  { id: "push-and-exit.go", outcome: "dismissed" },
  { id: "push-and-exit.drop-and-exit", outcome: "dismissed" },
];
