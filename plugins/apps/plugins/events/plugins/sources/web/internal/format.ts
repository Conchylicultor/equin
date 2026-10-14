import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  EXTRACTION_STATUSES,
  REFRESH_CADENCES,
  RUN_OUTCOMES,
  RUN_OUTCOME_META,
  SOURCE_STATES,
  SOURCE_STATUSES,
  type EventSourceRun,
  type ExtractionStatus,
  type RefreshCadence,
  type RunOutcome,
  type SourceState,
  type SourceStatus,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

// Display metadata for the Events source vocabularies, plus the run-row sentence.
// Pure data + string building (no React), so it is unit-testable and shared by
// every surface that paints a source — one label per value, in one place.
//
// Each map is keyed by the closed vocabulary's own union type, so adding a
// cadence / status / outcome to `events-core` is a tsc error here rather than a
// silently unlabelled chip.
//
// The `*_OPTIONS` arrays are what a DataView field hands to the chip cell, and
// they carry the LABEL, the TINT and the TOOLTIP together: an option describes
// how it presents, so no render site has to join a label map to a variant map by
// hand. The maps stay exported where a surface outside a DataView still paints a
// chip itself (the source-detail Status section, the run rows).

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const CADENCE_LABEL: Record<RefreshCadence, string> = {
  manual: "Manual",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
};

export const CADENCE_OPTIONS = REFRESH_CADENCES.map((c) => ({
  value: c,
  label: CADENCE_LABEL[c],
}));

export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  idle: "Idle",
  running: "Running",
  error: "Error",
};

export const SOURCE_STATUS_VARIANT: Record<SourceStatus, BadgeVariant> = {
  idle: "muted",
  running: "info",
  error: "destructive",
};

export const SOURCE_STATUS_OPTIONS = SOURCE_STATUSES.map((s) => ({
  value: s,
  label: SOURCE_STATUS_LABEL[s],
  variant: SOURCE_STATUS_VARIANT[s],
}));

/**
 * The derived "is this source working?" vocabulary (`extractionStatus`), as
 * chip text. Read alongside `SOURCE_STATUS_*`, which answers a different
 * question: that one is what the source is doing *right now*, this one is what
 * came out of it last time.
 */
export const EXTRACTION_STATUS_LABEL: Record<ExtractionStatus, string> = {
  never: "Never run",
  ok: "OK",
  empty: "Empty",
  failed: "Failed",
};

/**
 * `empty` is `warning`, NOT `success` — the one colour decision in this file
 * worth arguing about, so it is argued here.
 *
 * An empty extraction is a *successful run* with a *broken outcome*: the fetch
 * worked, the extraction worked, and zero events came back. That is exactly how
 * a scraped source dies quietly — the site changes its markup and every run
 * from then on is a green tick over an empty list. Colouring it `success`
 * because the run succeeded is precisely the hiding this status exists to undo.
 * It is not `destructive` either: a venue with nothing on is a legitimate
 * answer, and crying failure over it would train the user to ignore the chip.
 */
export const EXTRACTION_STATUS_VARIANT: Record<ExtractionStatus, BadgeVariant> =
  {
    never: "muted",
    ok: "success",
    empty: "warning",
    failed: "destructive",
  };

/**
 * One sentence per arm, rendered as the chip's `title`. A four-value status
 * chip is only self-explaining if hovering it says what the word means — and
 * `empty` in particular has to spell out that the run itself was fine, or the
 * user reads a warning colour as "the fetch broke" and goes looking in the
 * wrong place.
 */
export const EXTRACTION_STATUS_HINT: Record<ExtractionStatus, string> = {
  never:
    "No run has finished yet, so this source has never been asked anything.",
  ok: "The last extraction succeeded and found events.",
  empty:
    "The last extraction succeeded but found no events — the page may have changed.",
  failed: "The last run failed, so this source's events may be out of date.",
};

export const EXTRACTION_STATUS_OPTIONS = EXTRACTION_STATUSES.map((s) => ({
  value: s,
  label: EXTRACTION_STATUS_LABEL[s],
  variant: EXTRACTION_STATUS_VARIANT[s],
  hint: EXTRACTION_STATUS_HINT[s],
}));

/**
 * The `state` dimension — the ONE word a sources row says about a source, and
 * the only one of these vocabularies whose display metadata is not also a map
 * someone reads by hand: the chip cell reads the option.
 *
 * Nothing here is re-spelled. `running` borrows the source-status label and
 * tint it has always had, and the four extraction arms are spread in verbatim,
 * so a colour or a sentence still has exactly one definition. Only `disabled`
 * is new, because only `disabled` is new.
 *
 * Each map is a `Record<SourceState, …>`, so a new state member (or a new
 * extraction status that widens `SOURCE_STATES`) is a tsc error here.
 */
const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  disabled: "Disabled",
  running: SOURCE_STATUS_LABEL.running,
  ...EXTRACTION_STATUS_LABEL,
};

/**
 * `disabled` is `muted`, sharing a tint with `Never run` on purpose. Every other
 * variant is a coloured verdict about how the source is DOING —
 * `success`/`warning`/`destructive`/`info` — and an off source is making no
 * claim of that kind, so the honest paint is the quiet one. The accent
 * (`primary`) was the alternative and is wrong for the opposite reason: it would
 * make the loudest thing in a deliberately dimmed row the chip saying the row is
 * off. Nothing is lost to the shared tint — the two chips say different words,
 * and this one sits on a row that `rowTone` has muted with it.
 */
const SOURCE_STATE_VARIANT: Record<SourceState, BadgeVariant> = {
  disabled: "muted",
  running: SOURCE_STATUS_VARIANT.running,
  ...EXTRACTION_STATUS_VARIANT,
};

/** Hovering the chip says what the word means — see `EXTRACTION_STATUS_HINT`. */
const SOURCE_STATE_HINT: Record<SourceState, string> = {
  // Says all of what disabling does, not just the scheduler half: the events
  // dropping out of the list is the effect a user notices first and would
  // otherwise read as data loss.
  disabled: "Disabled — the scheduler skips it and its events are hidden",
  running: "A refresh is in flight right now.",
  ...EXTRACTION_STATUS_HINT,
};

export const SOURCE_STATE_OPTIONS = SOURCE_STATES.map((s) => ({
  value: s,
  label: SOURCE_STATE_LABEL[s],
  variant: SOURCE_STATE_VARIANT[s],
  hint: SOURCE_STATE_HINT[s],
}));

// Declared once with the run entity's `outcome` field (events-core's
// `RUN_OUTCOME_META`, which every list of runs derives its chip from); these
// read it for the surfaces that paint a chip themselves.
export const RUN_OUTCOME_LABEL = Object.fromEntries(
  RUN_OUTCOMES.map((o) => [o, RUN_OUTCOME_META[o].label]),
) as Record<RunOutcome, string>;

export const RUN_OUTCOME_VARIANT = Object.fromEntries(
  RUN_OUTCOMES.map((o) => [o, RUN_OUTCOME_META[o].variant ?? "muted"]),
) as Record<RunOutcome, BadgeVariant>;

export const RUN_OUTCOME_OPTIONS = RUN_OUTCOMES.map((o) => ({
  value: o,
  label: RUN_OUTCOME_LABEL[o],
  variant: RUN_OUTCOME_VARIANT[o],
}));

/** `null` when the run never recorded a duration (it is still in flight). */
export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/**
 * The one-line human account of a run — what the ledger is FOR.
 *
 * `unchanged` gets a full sentence rather than a bare word: it is the outcome a
 * user reads as "nothing happened, is it broken?", and the honest answer (the
 * page did not move, so the expensive phase was skipped on purpose) is the whole
 * payoff of the probe/extract split. Hiding or shortening it is what makes the
 * cache look like a bug.
 *
 * Worded for EVERY source type: not every one reads a "page" (some read a JSON
 * API) and not every extraction calls a model (structured sources map rows
 * directly), so neither is claimed. The cache key covers the config too, so
 * "unchanged" also means the filters are the ones last applied.
 */
export function describeRun(run: EventSourceRun): string {
  if (run.outcome === "unchanged") {
    return "Source and settings unchanged since the last extraction — skipped.";
  }
  if (run.outcome === "failed") {
    return run.error ?? "Failed with no recorded error.";
  }
  const parts = [`${run.eventsFound} found`];
  if (run.eventsCreated > 0) parts.push(`${run.eventsCreated} new`);
  if (run.eventsUpdated > 0) parts.push(`${run.eventsUpdated} updated`);
  if (run.eventsDisappeared > 0) parts.push(`${run.eventsDisappeared} gone`);
  if (parts.length === 1) parts.push("no changes");
  return parts.join(" · ");
}

/** Sentence-case a raw enum value that has no label map (defensive display). */
export function formatUnknownValue(value: string): string {
  return cap(value);
}
