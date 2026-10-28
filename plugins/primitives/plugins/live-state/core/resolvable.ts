import { z } from "zod";

/**
 * A `Resolvable<T>` is a payload that can carry a value OR a first-class
 * "there is nothing to determine" answer. It is the **value-channel twin** of
 * the live-state pending/error gate, and the two split a payload's failure
 * modes cleanly:
 *
 * - `error` (on the `ResourceResult`) means *"we failed to determine the value;
 *   a retry may succeed"* — it is **transient** and, per the readiness gate,
 *   **unreachable** to consumers (a `pending` result never exposes `.data`).
 *   A loader signals this by **throwing**.
 * - `{ resolved: false }` means *"the server has a determinate answer, and the
 *   answer is: there is nothing to determine"* — it is **settled**: it renders,
 *   it stops retrying, and it is a legitimate value a consumer reads and
 *   narrows on.
 *
 * The load-bearing rule (invariant I2 of
 * `research/2026-07-09-global-resource-unknown-value-and-error-gate.md`): a
 * loader branch that cannot determine its value returns `unresolved(reason)`.
 * It must **never** return the empty value (`[]` / `0` / `null`) — that is an
 * absorbed failure indistinguishable from a genuinely-empty success — and it
 * throws only for *transient* failures.
 *
 * `reason` is human-facing text rendered in the UI (e.g. "conversation has no
 * worktree"), so the settled non-value can explain itself to the user.
 */
export type Resolvable<T> =
  { resolved: true; value: T } | { resolved: false; reason: string };

/**
 * Builds the Zod schema for `Resolvable<T>` from the inner value schema. Uses a
 * discriminated union on `resolved` so a payload missing the discriminant — or
 * carrying the wrong arm's fields (e.g. `resolved: true` with no `value`) —
 * fails to parse, and `value` is validated by `inner` on the resolved arm.
 *
 * The `as` cast is unavoidable, not laziness, and it is an OUTPUT-side
 * problem: Zod's object-output inference widens `value`
 * to `T | undefined` (its `addQuestionMarks`/`baseObjectOutputType` cannot prove
 * a generic `T` is never `undefined`), so the discriminated union is not
 * provably assignable to `z.ZodType<Resolvable<T>>`. The runtime shape is
 * exactly correct; only the type-level generic proof falls short.
 */
export function resolvableSchema<T>(
  inner: z.ZodType<T>,
): z.ZodType<Resolvable<T>> {
  return z.discriminatedUnion("resolved", [
    z.object({ resolved: z.literal(false), reason: z.string() }),
    z.object({ resolved: z.literal(true), value: inner }),
  ]) as unknown as z.ZodType<Resolvable<T>>;
}

/** The resolved arm: the server vouches for `value`. */
export function resolved<T>(value: T): Resolvable<T> {
  return { resolved: true, value };
}

/**
 * The unresolved arm: a determinate "nothing to determine", carrying
 * human-facing `reason` text. Typed `Resolvable<never>` so it is assignable to
 * `Resolvable<T>` for any `T` without naming the value type at the call site.
 */
export function unresolved(reason: string): Resolvable<never> {
  return { resolved: false, reason };
}
