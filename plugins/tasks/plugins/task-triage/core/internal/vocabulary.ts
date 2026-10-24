import type { FieldOptionMeta } from "@plugins/fields/core";

// The closed sets a triage read is made of, as plain data (no plugin adds a
// state, a priority or a type), each with its presentation — the one source
// every chip reads (the card, the exposed list fields, the autopilot's launch
// list), so two surfaces cannot disagree on a label or a tint.

/**
 * Where a task's triage stands. A task with no row is not triaged at all
 * (`null` on the exposed field, "Not triaged").
 *
 * - `queued` — asked for; waiting for a free slot (`concurrency`).
 * - `running` — a read-only agent is reading it now.
 * - `done` — the latest read describes the task.
 * - `stale` — the latest read is older than `staleAfterDays`, or the task was
 *   edited since (`staleReason`). Written, so lists filter by it.
 * - `failed` — the latest run ended without a read (its `error`).
 */
export const TRIAGE_STATES = [
  "queued",
  "running",
  "done",
  "stale",
  "failed",
] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];

/** A run is in flight: requesting again does nothing. */
export const TRIAGE_IN_FLIGHT_STATES = [
  "queued",
  "running",
] as const satisfies readonly TriageState[];

export const TRIAGE_STATE_META: Record<TriageState, FieldOptionMeta> = {
  queued: {
    label: "Queued",
    variant: "muted",
    hint: "Triage was asked for and waits for a free slot.",
  },
  running: {
    label: "Triaging",
    variant: "info",
    hint: "A read-only agent is reading the task now.",
  },
  done: {
    label: "Triaged",
    variant: "success",
    hint: "The latest read describes the task as it is.",
  },
  stale: {
    label: "Stale",
    variant: "warning",
    hint: "The latest read is old, or the task was edited since. Re-run it.",
  },
  failed: {
    label: "Triage failed",
    variant: "destructive",
    hint: "The latest run ended without a read. Re-run it.",
  },
};

/** What a missing row reads on the exposed `state` field. */
export const NOT_TRIAGED_META: FieldOptionMeta = {
  label: "Not triaged",
  hint: "Nobody asked for a triage of this task yet.",
  quiet: true,
};

/** Why a read went stale. */
export const TRIAGE_STALE_REASONS = ["old", "edited"] as const;
export type TriageStaleReason = (typeof TRIAGE_STALE_REASONS)[number];

export const TRIAGE_STALE_REASON_META: Record<
  TriageStaleReason,
  FieldOptionMeta
> = {
  old: {
    label: "Old",
    hint: "The read is older than the configured stale age.",
  },
  edited: {
    label: "Edited",
    hint: "The task's title or description changed since it was read.",
  },
};

/**
 * MoSCoW priority for the current timebox, in rank order (must first) —
 * `compareByTriage` and every grouping read this order.
 */
export const TRIAGE_PRIORITIES = ["must", "should", "could", "wont"] as const;
export type TriagePriority = (typeof TRIAGE_PRIORITIES)[number];

export const TRIAGE_PRIORITY_META: Record<TriagePriority, FieldOptionMeta> = {
  must: {
    label: "Must",
    variant: "destructive",
    hint: "Without it, the release is not viable.",
  },
  should: {
    label: "Should",
    variant: "warning",
    hint: "Important and painful to leave out, but there is a workaround.",
  },
  could: {
    label: "Could",
    variant: "info",
    hint: "Desirable, small impact if left out: the first thing cut.",
  },
  wont: {
    label: "Won't",
    variant: "muted",
    hint: "Explicitly out of scope for this timebox — not 'never'.",
  },
};

/** What kind of work a task is. */
export const TRIAGE_TASK_TYPES = [
  "feature",
  "bugfix",
  "cleanup",
  "testing",
  "other",
] as const;
export type TriageTaskType = (typeof TRIAGE_TASK_TYPES)[number];

export const TRIAGE_TASK_TYPE_META: Record<TriageTaskType, FieldOptionMeta> = {
  feature: {
    label: "Feature",
    variant: "primary",
    hint: "New behaviour, or a change to what the app does.",
  },
  bugfix: {
    label: "Bugfix",
    variant: "destructive",
    hint: "Something is actually broken.",
  },
  cleanup: {
    label: "Cleanup",
    variant: "muted",
    hint: "Refactoring, removing debt or dead code; no visible change.",
  },
  testing: {
    label: "Testing",
    variant: "info",
    hint: "Tests, checks or verification.",
  },
  other: { label: "Other", variant: "muted", hint: "None of the above." },
};

/**
 * What triage made of a task.
 *
 * - `ready` — clear in scope; an unattended agent can do it without asking.
 * - `decide` — doable, but one call is the person's to make (its `question`).
 * - `split` — too big for one unattended session (its `question` proposes how
 *   to split it).
 * - `obsolete` — already fixed on main, or the code it names is gone.
 */
export const TRIAGE_VERDICTS = [
  "ready",
  "decide",
  "split",
  "obsolete",
] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

export const TRIAGE_VERDICT_META: Record<TriageVerdict, FieldOptionMeta> = {
  ready: {
    label: "Ready",
    variant: "success",
    hint: "Clear in scope: an agent can do it without asking.",
  },
  decide: {
    label: "Decide",
    variant: "warning",
    hint: "Doable, but one call is yours to make.",
  },
  split: {
    label: "Split",
    variant: "info",
    hint: "Too big for one session; split it first.",
  },
  obsolete: {
    label: "Obsolete",
    variant: "muted",
    hint: "Already fixed on main, or the code it names is gone.",
  },
};

/** How much a person relies on what it would change. */
export const TRIAGE_RISKS = ["low", "medium", "high"] as const;
export type TriageRisk = (typeof TRIAGE_RISKS)[number];

export const TRIAGE_RISK_META: Record<TriageRisk, FieldOptionMeta> = {
  low: {
    label: "Low risk",
    variant: "success",
    hint: "A local fix nobody would notice except as 'fixed'.",
  },
  medium: {
    label: "Medium risk",
    variant: "warning",
    hint: "A contained behaviour change.",
  },
  high: {
    label: "High risk",
    variant: "destructive",
    hint: "Changes behaviour a person relies on, a shared primitive, a schema, auth or the gateway.",
  },
};

/** At most this many one-click answers to triage's question. */
export const MAX_TRIAGE_ANSWERS = 4;
/** At most this many plugin areas a read names. */
export const MAX_TRIAGE_AREAS = 12;
