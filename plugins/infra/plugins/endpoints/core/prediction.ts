// Every write endpoint decides how its effect reaches the user — design in
// research/2026-10-28-global-endpoint-prediction-decision.md §1–2. A write's
// options take exactly one arm (`defineEndpoint`): `effect` (predicted),
// `unpredicted` (a stated reason, or a gap: debt), `internal` (no browser
// client), or none of them for `agentWrite: "telemetry"`. This module holds
// the vocabulary of the two non-predicted arms.

/**
 * Why a write is not predicted, for good — a closed union, so the reason is
 * stated and grep-able. A write that SHOULD be predicted but cannot be yet is
 * not one of these: it declares a {@link PredictionGap}.
 *
 * - `"server-minted-id"` — the caller needs an id the server mints, to
 *   navigate to it or select it. (The way out, per endpoint: a client-minted
 *   id, `defineIdKind`'s portable `mint`.)
 * - `"response"` — the surface renders the answer: a result union, a tally, a
 *   resolved status. A response-driven side effect (a toast) is not this —
 *   `useLiveMutation`'s `onSuccess` covers it.
 * - `"precondition"` — a server-checked 409 / 400 the surface shows inline;
 *   never-revert plus a rejection toast is wrong for an inline field error.
 * - `"server-decided"` — the request does not decide the outcome: an LLM, an
 *   external API, a job, the filesystem or git does. The pending state is the
 *   honest UX.
 * - `"unobserved"` — the write is bookkeeping no surface renders back (a
 *   viewed-at stamp, a GC hold, an upload the caller already holds): there is
 *   nothing to show early.
 */
export type UnpredictedReason =
  | "server-minted-id"
  | "response"
  | "precondition"
  | "server-decided"
  | "unobserved";

/** {@link UnpredictedReason} as data — the runtime backstop's allow-list. */
export const UNPREDICTED_REASONS: ReadonlySet<string> =
  new Set<UnpredictedReason>([
    "server-minted-id",
    "response",
    "precondition",
    "server-decided",
    "unobserved",
  ]);

/**
 * Prediction debt: what blocks an endpoint that should be predicted, one entry
 * per gap with the task that closes it. An endpoint names only the gap
 * (`unpredicted: { gap: "web-context" }`), never the task.
 *
 * Closing a gap DELETES its entry: every endpoint still declaring it becomes a
 * tsc error, so the compiler lists the migration — no allowlist to keep in
 * sync. The gaps the first migration closed (`call-sites`, `upsert`,
 * `conditional`, `increment`, `live-value`, `lanes`, `where`, `ranks`) are gone.
 */
export const PREDICTION_GAPS = {
  "web-context": {
    task: "task-1793239613-l0n44t",
    what: "The effect needs web-only context a core effect cannot see (the page editor's block-handle registry — useBlockOpContext — its undo stack's restoreIds, its OpNoLongerApplies replay guard); predicted meanwhile by useOptimisticResource.",
  },
} as const satisfies Record<string, { task: string; what: string }>;

/** A gap blocking a prediction — a key of {@link PREDICTION_GAPS}. */
export type PredictionGap = keyof typeof PREDICTION_GAPS;

/**
 * A write's `unpredicted` arm: a stated {@link UnpredictedReason} with its
 * `why` (required, non-empty — checked at declaration), or a
 * {@link PredictionGap} (debt; its task is the gap's, never repeated here).
 */
export type Unpredicted =
  | { reason: UnpredictedReason; why: string; gap?: never }
  | { gap: PredictionGap; reason?: never; why?: never };

/**
 * A write's `internal` arm: no browser client — a server → central RPC, an
 * e2e or CLI hook. `why` is required and non-empty. The definition is an
 * `InternalEndpointDef`, which the browser's clients refuse (tsc).
 */
export type InternalDecl = { why: string };
