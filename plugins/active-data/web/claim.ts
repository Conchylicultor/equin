import type { ComponentType } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/**
 * The answer a `display:"code"` contribution gives when the host asks "is this
 * backticked token yours?".
 *
 * Three arms, mirroring live-state's two-channel model:
 *
 * - `pending`  — no trustworthy answer yet (I/O in flight). The host renders the
 *   plain terminal `<code>` and does **not** consult the next candidate: a level
 *   below a still-loading one would mount, fire its own I/O, and be discarded the
 *   moment the answer lands.
 * - `declined` — a determinate non-answer, with a reason. The host moves on to the
 *   next syntactic candidate.
 * - `claimed`  — resolved; the host renders the contribution's component with the
 *   value the claim produced.
 *
 * There is deliberately no "I couldn't handle this, here's a plain code element"
 * arm: rendering a fallback is the host's job, so a contributor cannot publish a
 * decline as an absorbable success (the defect this protocol replaces).
 */
export type CodeClaim<T> =
  | { status: "pending" }
  | { status: "declined"; reason: string }
  | { status: "claimed"; value: T };

const PENDING: CodeClaim<never> = { status: "pending" };

/** No trustworthy answer yet — the host renders the terminal `<code>` and stops. */
export function claimPending<T>(): CodeClaim<T> {
  return PENDING;
}

/** A determinate non-answer — the host consults the next candidate. */
export function declined<T>(reason: string): CodeClaim<T> {
  return { status: "declined", reason };
}

/** Resolved — the host renders this contribution's component with `value`. */
export function claimed<T>(value: T): CodeClaim<T> {
  return { status: "claimed", value };
}

/**
 * The semantic half of a `display:"code"` contribution: the hook that decides,
 * paired with the component that is unreachable except on a claim.
 *
 * The two halves are sealed together by `codeTag()` (in `./slots`) precisely so a
 * contributor cannot supply a component reachable without a claim — `component`
 * takes the very `T` that `useClaim` produces, so "matched syntactically but
 * cannot resolve" has no representable rendering.
 */
export interface CodeResolver<T> {
  useClaim: Hook<(text: string) => CodeClaim<T>>;
  component: ComponentType<{ content: string; value: T }>;
  /**
   * What holds the token's place while the claim is `pending` — the claimed
   * chip's own box, without what only a claim knows (no activation, no hover
   * card). Omitted: the plain terminal `<code>`. Worth declaring only for a
   * candidate whose syntactic matches almost always resolve (a backticked
   * sha): the chip then lands in the box it already had, instead of widening
   * the span and re-wrapping the paragraph under the reader. A decline still
   * falls back to the terminal, so a candidate that often declines keeps the
   * default.
   */
  pending?: ComponentType<{ content: string }>;
}
