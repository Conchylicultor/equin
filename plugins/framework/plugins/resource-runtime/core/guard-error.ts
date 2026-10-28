/**
 * An error the runtime raises itself, from one of its guards (route drift, a
 * non-canonical tuple, an unserved key) — not one a loader threw.
 *
 * Its stack names only the guard, the same frames for every resource it fires
 * on, so a report fingerprinted by stack would merge every resource's problem
 * onto one row. `identity` — the guard and the resource key — is what tells
 * them apart; a host's error reporter files it as the report's error type.
 */
export class ResourceGuardError extends Error {
  constructor(
    readonly guard: "RouteDrift" | "NonCanonicalParams" | "UnservedKey",
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "ResourceGuardError";
  }

  get identity(): string {
    return `${this.guard} ${this.key}`;
  }
}
