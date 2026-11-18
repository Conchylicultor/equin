/**
 * Something only a person can decide, once it has waited past its bound — a
 * pinned host daemon lagging main for longer than its pin may (infra/deps
 * `pin-review`). The upgrade task carries it so it cannot be ignored, but its
 * agent never acts on it: it raises a flag listing each, with its options.
 */
export interface PendingDecision {
  /** What it is about, e.g. the dependency id. */
  subject: string;
  /** A short phrase for the task title. */
  title: string;
  /** Where it stands, in one line: the versions, since when, what blocks it. */
  situation: string;
  /** Each answer a person may give, with the command that records it. */
  options: readonly string[];
}

/** A source of {@link PendingDecision}s the Dependency upgrades automation asks on each run. */
export interface DecisionSource {
  /** Stable id: the automation's source key (it can be excluded like an updater). */
  readonly id: string;
  readonly label: string;
  /** The decisions due on `now` — past their bound, and not deferred by a decision still in force. */
  pending(now: Date): Promise<readonly PendingDecision[]>;
}

/** The decisions' section of the upgrade task text, empty when there are none. */
export function decisionSection(decisions: readonly PendingDecision[]): string {
  if (decisions.length === 0) return "";
  return [
    "Decisions only a person can make — do NOT act on them (never switch a pin, never restart Postgres, PgBouncer",
    "or the gateway). Raise ONE flag (flag_raise) listing each, its situation and its options, then carry on with",
    "the rest of this task:",
    ...decisions.flatMap((d) => [
      `- [ ] ${d.subject}: ${d.situation}`,
      ...d.options.map((o) => `  - ${o}`),
    ]),
  ].join("\n");
}
